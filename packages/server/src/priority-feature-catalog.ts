import type Database from "better-sqlite3";

import {
  canonicalPriorityFeatureProjection,
  createPriorityEngine,
  priorityFeatureAggregateMaximumBytes,
  priorityFeatureSetMaximumValues,
  priorityFeatureValueMaximumBytes,
  readActivePriorityRuleset,
  type PriorityEligibility,
  type PriorityFeatures,
  type PriorityOutcome,
  type PriorityRulesetRef,
  type PrioritySubject,
} from "./priority-engine.js";

export type PriorityFeatureCatalogErrorCode =
  | "PRIORITY_FEATURE_SUBJECT_NOT_FOUND"
  | "PRIORITY_FEATURE_RESOURCE_NOT_ACTIVE"
  | "PRIORITY_FEATURE_STORAGE_CORRUPT"
  | "PRIORITY_FEATURE_INVALID_ANCHOR"
  | "PRIORITY_FEATURE_INVALID_CURSOR";

export class PriorityFeatureCatalogError extends Error {
  constructor(
    readonly code: PriorityFeatureCatalogErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PriorityFeatureCatalogError";
  }
}

export interface PriorityFeatureRead {
  readonly subject: PrioritySubject;
  readonly features: PriorityFeatures;
  readonly eligibility: PriorityEligibility;
  readonly featureFingerprint: string;
  readonly ruleset: PriorityRulesetRef;
  readonly desiredAssessmentMethod: "rule";
  readonly currentOutcome: PriorityOutcome | null;
  readonly isCurrent: boolean;
  readonly dirty: boolean;
  readonly needsReview: boolean;
}

export interface PriorityFeatureProjectionRead {
  readonly subject: PrioritySubject;
  readonly features: PriorityFeatures;
  readonly eligibility: PriorityEligibility;
  readonly featureFingerprint: string;
}

export interface PriorityReviewQueuePage {
  readonly items: readonly PriorityFeatureRead[];
  readonly nextCursor: string | null;
}

export interface PriorityFeatureCatalog {
  read(subject: PrioritySubject, anchor: string): PriorityFeatureRead;
  readBatch(subjects: readonly PrioritySubject[], anchor: string): readonly PriorityFeatureRead[];
  previewBatch(
    subjects: readonly PrioritySubject[],
    anchor: string,
  ): readonly PriorityFeatureProjectionRead[];
  listSubjects(): readonly PrioritySubject[];
  listSubjectPage(input: {
    readonly after?: PrioritySubject;
    readonly limit: number;
  }): {
    readonly items: readonly PrioritySubject[];
    readonly nextAfter: PrioritySubject | null;
  };
  reviewQueue(input: {
    readonly anchor: string;
    readonly limit: number;
    readonly cursor?: string;
  }): PriorityReviewQueuePage;
}

interface PageRow {
  id: number;
  created_at: string;
  updated_at: string;
}

interface ResourceRow {
  id: number;
  created_at: string;
  lifecycle_state: string;
  access_class: string;
}

interface ActivityWriterRow {
  state: string;
  coverage_started_at: string | null;
  updated_at: string;
  availability_started_at: string | null;
}

interface ResolutionRow {
  id: number;
  logical_page_id: number;
  state: string;
  reason: string;
}

interface StringValueRow { value: string }

export type PriorityProjectionFactFamily =
  | "boolean"
  | "number"
  | "set"
  | "empty_set"
  | "eligibility";

/**
 * The deliberately small input language shared by direct Catalog reads and
 * the SQLite coverage aggregate. It contains projected signals, never source
 * bodies or private context. Keeping the reducer pure is what makes a guard
 * projection comparable with the normal read path.
 */
export interface PriorityProjectionFact {
  readonly subjectType: "page" | "resource";
  readonly subjectId: number;
  readonly anchor: string;
  readonly family: PriorityProjectionFactFamily;
  readonly key: string;
  readonly textValue: string | null;
  readonly numberValue: number | null;
}

function factStorageCorrupt(message: string): never {
  throw new Error(`Invalid priority projection fact: ${message}`);
}

export function reducePriorityProjectionFacts(
  facts: readonly PriorityProjectionFact[],
): ReturnType<typeof canonicalPriorityFeatureProjection> {
  const first = facts[0];
  if (first === undefined) factStorageCorrupt("empty subject group");
  const subject: PrioritySubject = first.subjectType === "page"
    ? { type: "page", logicalPageId: first.subjectId }
    : { type: "resource", resourceId: first.subjectId };
  const raw: Record<string, boolean | number | readonly string[]> = {};
  const sets = new Map<string, string[]>();
  const emptySetKeys = new Set<string>();
  const scalarKeys = new Set<string>();
  let eligibility: PriorityEligibility | undefined;
  for (const fact of facts) {
    if (fact.subjectType !== first.subjectType || fact.subjectId !== first.subjectId ||
        fact.anchor !== first.anchor || !Number.isSafeInteger(fact.subjectId) || fact.subjectId <= 0 ||
        typeof fact.key !== "string" || fact.key.length < 1 || fact.key.trim() !== fact.key) {
      factStorageCorrupt("mixed subject group or invalid identity");
    }
    anchorDate(fact.anchor);
    if (fact.family === "boolean") {
      if (fact.textValue !== null || (fact.numberValue !== 0 && fact.numberValue !== 1)) {
        factStorageCorrupt(`invalid boolean ${fact.key}`);
      }
      if (scalarKeys.has(fact.key) || sets.has(fact.key)) {
        factStorageCorrupt(`duplicate scalar ${fact.key}`);
      }
      scalarKeys.add(fact.key);
      raw[fact.key] = fact.numberValue === 1;
    } else if (fact.family === "number") {
      if (fact.textValue !== null || typeof fact.numberValue !== "number" ||
          !Number.isSafeInteger(fact.numberValue) || fact.numberValue < 0) {
        factStorageCorrupt(`invalid number ${fact.key}`);
      }
      if (scalarKeys.has(fact.key) || sets.has(fact.key)) {
        factStorageCorrupt(`duplicate scalar ${fact.key}`);
      }
      scalarKeys.add(fact.key);
      raw[fact.key] = fact.numberValue;
    } else if (fact.family === "set") {
      if (fact.numberValue !== null || typeof fact.textValue !== "string" ||
          fact.textValue.length < 1 || fact.textValue.trim() !== fact.textValue) {
        factStorageCorrupt(`invalid set value ${fact.key}`);
      }
      if (scalarKeys.has(fact.key) || emptySetKeys.has(fact.key)) {
        factStorageCorrupt(`mixed feature ${fact.key}`);
      }
      const values = sets.get(fact.key) ?? [];
      values.push(fact.textValue);
      sets.set(fact.key, values);
    } else if (fact.family === "empty_set") {
      if (fact.numberValue !== null || fact.textValue !== null ||
          scalarKeys.has(fact.key) || sets.has(fact.key)) {
        factStorageCorrupt(`invalid or duplicate empty set ${fact.key}`);
      }
      sets.set(fact.key, []);
      emptySetKeys.add(fact.key);
    } else if (fact.family === "eligibility") {
      if (eligibility !== undefined || fact.numberValue !== null) {
        factStorageCorrupt("duplicate eligibility");
      }
      if (fact.key === "eligible" && fact.textValue === null) {
        eligibility = { kind: "eligible" };
      } else if (fact.key === "temporarily_unavailable" && fact.textValue !== null) {
        eligibility = { kind: "excluded", reason: "temporarily_unavailable",
          detail: { source: "eligibility", code: fact.textValue } };
      } else if (fact.key === "unsupported_url" && fact.textValue !== null) {
        eligibility = { kind: "excluded", reason: "unsupported_url",
          detail: { source: "url_policy", code: fact.textValue } };
      } else if (fact.key === "private_or_internal" && fact.textValue !== null) {
        eligibility = { kind: "excluded", reason: "private_or_internal",
          detail: { source: "url_policy", code: fact.textValue } };
      } else {
        factStorageCorrupt("invalid eligibility");
      }
    } else {
      factStorageCorrupt("invalid family");
    }
  }
  if (eligibility === undefined) factStorageCorrupt("missing eligibility");
  let aggregateBytes = 0;
  const exceededKeys = new Set<string>();
  for (const [key, sourceValues] of sets) {
    const values = [...new Set(sourceValues)].sort();
    const bytes = values.reduce((total, value) => total + Buffer.byteLength(value, "utf8"), 0);
    aggregateBytes += bytes;
    if (values.length > priorityFeatureSetMaximumValues ||
        values.some((value) => Buffer.byteLength(value, "utf8") >
          priorityFeatureValueMaximumBytes)) {
      exceededKeys.add(key);
    } else {
      raw[key] = values;
    }
  }
  if (aggregateBytes > priorityFeatureAggregateMaximumBytes) {
    for (const key of sets.keys()) delete raw[key];
    eligibility = { kind: "excluded", reason: "temporarily_unavailable",
      detail: { source: "eligibility", code: "feature_set_limit_exceeded" } };
  } else if (exceededKeys.size > 0) {
    for (const key of exceededKeys) delete raw[key];
    eligibility = { kind: "excluded", reason: "temporarily_unavailable",
      detail: { source: "eligibility", code: "feature_set_limit_exceeded" } };
  }
  return canonicalPriorityFeatureProjection({ subject, features: raw, eligibility });
}

export function priorityProjectionFactsFromValues(input: {
  readonly subject: PrioritySubject;
  readonly anchor: string;
  readonly features: Readonly<Record<string, boolean | number | readonly string[]>>;
  readonly eligibility: PriorityEligibility;
}): readonly PriorityProjectionFact[] {
  const subjectType = input.subject.type;
  const subjectId = subjectType === "page" ? input.subject.logicalPageId : input.subject.resourceId;
  const facts: PriorityProjectionFact[] = [];
  for (const [key, value] of Object.entries(input.features)) {
    if (typeof value === "boolean") {
      facts.push({ subjectType, subjectId, anchor: input.anchor, family: "boolean", key,
        textValue: null, numberValue: value ? 1 : 0 });
    } else if (typeof value === "number") {
      facts.push({ subjectType, subjectId, anchor: input.anchor, family: "number", key,
        textValue: null, numberValue: value });
    } else {
      if (value.length === 0) {
        facts.push({ subjectType, subjectId, anchor: input.anchor,
          family: "empty_set", key, textValue: null, numberValue: null });
      } else {
        for (const item of value) facts.push({ subjectType, subjectId, anchor: input.anchor,
          family: "set", key, textValue: item, numberValue: null });
      }
    }
  }
  facts.push({ subjectType, subjectId, anchor: input.anchor, family: "eligibility",
    key: input.eligibility.kind === "eligible" ? "eligible" : input.eligibility.reason,
    textValue: input.eligibility.kind === "eligible" ? null : input.eligibility.detail?.code ?? "unspecified",
    numberValue: null });
  return facts;
}

export const priorityProjectionAggregateName = "tabhub_priority_projection_v1";
const priorityProjectionAggregateRegistrations = new WeakSet<object>();

interface PriorityProjectionAggregateState {
  readonly facts: PriorityProjectionFact[];
  readonly setCounts: Map<string, number>;
  setBytes: number;
  aggregateLimitProven: boolean;
}

export function registerPriorityProjectionAggregate(connection: Database.Database): void {
  if (priorityProjectionAggregateRegistrations.has(connection)) {
    throw new Error("Priority projection aggregate already registered on this connection");
  }
  const step = (
    state: PriorityProjectionAggregateState,
    subjectType: unknown,
    subjectId: unknown,
    at: unknown,
    family: unknown,
    key: unknown,
    textValue: unknown,
    numberValue: unknown,
  ): void => {
    if ((subjectType !== "page" && subjectType !== "resource") ||
        typeof subjectId !== "number" || !Number.isSafeInteger(subjectId) || subjectId <= 0 ||
        typeof at !== "string" ||
        (family !== "boolean" && family !== "number" && family !== "set" &&
          family !== "empty_set" && family !== "eligibility") || typeof key !== "string" ||
        (textValue !== null && typeof textValue !== "string") ||
        (numberValue !== null && typeof numberValue !== "number")) {
      factStorageCorrupt(`invalid aggregate arguments ${JSON.stringify([
        subjectType, subjectId, at, family, key, textValue, numberValue,
      ])}`);
    }
    if (family === "set") {
      const count = (state.setCounts.get(key) ?? 0) + 1;
      state.setCounts.set(key, count);
      if (state.aggregateLimitProven || count > priorityFeatureSetMaximumValues + 1) return;
      const valueBytes = Buffer.byteLength(textValue as string, "utf8");
      if (count <= priorityFeatureSetMaximumValues + 1) {
        state.facts.push({ subjectType, subjectId, anchor: at,
          family, key, textValue, numberValue });
      }
      state.setBytes += valueBytes;
      if (state.setBytes > priorityFeatureAggregateMaximumBytes) {
        state.aggregateLimitProven = true;
      }
      return;
    }
    state.facts.push({ subjectType, subjectId, anchor: at,
      family, key, textValue, numberValue });
  };
  connection.aggregate<PriorityProjectionAggregateState>(priorityProjectionAggregateName, {
    deterministic: true,
    directOnly: true,
    start: () => ({ facts: [], setCounts: new Map(), setBytes: 0,
      aggregateLimitProven: false }),
    step: step as never,
    result: (state) => reducePriorityProjectionFacts(state.facts).featureFingerprint,
  });
  const sentinel = connection.prepare(`
    SELECT ${priorityProjectionAggregateName}(
      'page', 1, '2026-01-01T00:00:00.000Z', family, key, text_value, number_value
    ) AS value
    FROM (
      SELECT 'boolean' AS family, 'is_open' AS key, NULL AS text_value, 0 AS number_value
      UNION ALL SELECT 'eligibility', 'eligible', NULL, NULL
    )
  `).pluck().get();
  const expected = reducePriorityProjectionFacts(priorityProjectionFactsFromValues({
    subject: { type: "page", logicalPageId: 1 },
    anchor: "2026-01-01T00:00:00.000Z",
    features: { is_open: false }, eligibility: { kind: "eligible" },
  })).featureFingerprint;
  if (sentinel !== expected) throw new Error("Priority projection aggregate self-check failed");
  priorityProjectionAggregateRegistrations.add(connection);
}

const privateResolutionReasons = new Set([
  "browser_internal",
  "extension",
  "file",
  "data",
  "embedded_credentials",
  "localhost",
  "private_ip",
  "private_hostname",
]);

const unsupportedResolutionReasons = new Set([
  "invalid_url",
  "unsupported_scheme",
  "registrable_domain_unavailable",
]);

function storageCorrupt(message: string): never {
  throw new PriorityFeatureCatalogError("PRIORITY_FEATURE_STORAGE_CORRUPT", message);
}

function canonicalTimestamp(value: string, context: string): string {
  if (typeof value !== "string") storageCorrupt(`${context} is not a timestamp`);
  try {
    if (new Date(value).toISOString() !== value) {
      storageCorrupt(`${context} is not a canonical timestamp`);
    }
  } catch {
    storageCorrupt(`${context} is not a canonical timestamp`);
  }
  return value;
}

function anchorDate(value: string): Date {
  try {
    if (new Date(value).toISOString() !== value) throw new Error("noncanonical");
    return new Date(value);
  } catch {
    throw new PriorityFeatureCatalogError(
      "PRIORITY_FEATURE_INVALID_ANCHOR",
      "Priority feature anchor must be a canonical ISO timestamp",
    );
  }
}

function utcDayNumber(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function utcDayDifference(anchor: Date, timestamp: string, context: string): number {
  const source = new Date(canonicalTimestamp(timestamp, context));
  return Math.max(0, Math.floor((utcDayNumber(anchor) - utcDayNumber(source)) / 86_400_000));
}

function subjectKey(subject: PrioritySubject): string {
  return subject.type === "page"
    ? `page:${subject.logicalPageId}`
    : `resource:${subject.resourceId}`;
}

function positiveId(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new PriorityFeatureCatalogError(
      "PRIORITY_FEATURE_SUBJECT_NOT_FOUND",
      `${name} must be a positive safe integer`,
    );
  }
  return value;
}

function normalizeSubject(subject: PrioritySubject): PrioritySubject {
  if (subject?.type === "page") {
    return { type: "page", logicalPageId: positiveId(subject.logicalPageId, "logicalPageId") };
  }
  if (subject?.type === "resource") {
    return { type: "resource", resourceId: positiveId(subject.resourceId, "resourceId") };
  }
  throw new PriorityFeatureCatalogError(
    "PRIORITY_FEATURE_SUBJECT_NOT_FOUND",
    "Priority subject must be a page or resource",
  );
}

function scalarCount(value: unknown, context: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) storageCorrupt(`${context} is invalid`);
  return result;
}

function boundedStringSet(rows: readonly StringValueRow[], context: string): {
  readonly values: readonly string[];
  readonly bytes: number;
  readonly exceeded: boolean;
} {
  const values = [...new Set(rows.map((row) => {
    if (typeof row.value !== "string" || row.value.trim() !== row.value || row.value.length === 0) {
      storageCorrupt(`${context} contains invalid text`);
    }
    return row.value;
  }))].sort();
  const bytes = values.reduce((sum, value) => sum + Buffer.byteLength(value, "utf8"), 0);
  const exceeded = values.length > priorityFeatureSetMaximumValues ||
    values.some((value) => Buffer.byteLength(value, "utf8") > priorityFeatureValueMaximumBytes);
  return { values, bytes, exceeded };
}

function currentOutcomeMatches(
  outcome: PriorityOutcome | null,
  fingerprint: string,
  ruleset: PriorityRulesetRef,
): boolean {
  if (outcome === null) return false;
  const value = outcome.kind === "assessment" ? outcome.assessment : outcome.exclusion;
  if (value.featureFingerprint !== fingerprint ||
      value.ruleset.rulesetId !== ruleset.rulesetId ||
      value.ruleset.version !== ruleset.version) return false;
  return outcome.kind === "exclusion" ||
    outcome.assessment.assessmentMethod === "rule" && outcome.assessment.modelProvenance === null;
}

function outcomeNeedsReview(outcome: PriorityOutcome | null): boolean {
  return outcome?.kind === "assessment" && outcome.assessment.needsReview;
}

function encodeCursor(subject: PrioritySubject): string {
  return Buffer.from(JSON.stringify({ version: 1, subject }), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): PrioritySubject | null {
  if (value === undefined) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error("noncanonical");
    const parsed = JSON.parse(decoded.toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
        Object.keys(parsed).sort().join(",") !== "subject,version" ||
        (parsed as { version?: unknown }).version !== 1) throw new Error("invalid");
    const subject = (parsed as { subject: PrioritySubject }).subject;
    if (subject === null || typeof subject !== "object" || Array.isArray(subject) ||
        subject.type === "page" && Object.keys(subject).sort().join(",") !==
          "logicalPageId,type" ||
        subject.type === "resource" && Object.keys(subject).sort().join(",") !==
          "resourceId,type") throw new Error("invalid subject");
    return normalizeSubject(subject);
  } catch {
    throw new PriorityFeatureCatalogError(
      "PRIORITY_FEATURE_INVALID_CURSOR",
      "Priority review cursor is invalid",
    );
  }
}

export function createPriorityFeatureCatalog(
  connection: Database.Database,
): PriorityFeatureCatalog {
  registerPriorityProjectionAggregate(connection);
  const engine = createPriorityEngine(connection);
  const pageById = connection.prepare(`
    SELECT id, created_at, updated_at FROM logical_pages WHERE id = ?
  `);
  const resourceById = connection.prepare(`
    SELECT resources.id, resources.created_at, events.lifecycle_state, events.access_class
    FROM resources
    JOIN resource_heads AS heads ON heads.resource_id = resources.id
    JOIN resource_events AS events
      ON events.id = heads.event_id AND events.resource_id = heads.resource_id
    WHERE resources.id = ?
  `);
  const allPageIds = connection.prepare("SELECT id FROM logical_pages ORDER BY id");
  const allActiveResourceIds = connection.prepare(`
    SELECT resources.id
    FROM resources
    JOIN resource_heads AS heads ON heads.resource_id = resources.id
    JOIN resource_events AS events
      ON events.id = heads.event_id AND events.resource_id = heads.resource_id
    WHERE events.lifecycle_state = 'active'
    ORDER BY resources.id
  `);
  const subjectsAfter = connection.prepare(`
    WITH candidates(type_rank,type,id) AS (
      SELECT 0,'page',id FROM logical_pages
      UNION ALL
      SELECT 1,'resource',resources.id FROM resources
      JOIN resource_heads AS heads ON heads.resource_id=resources.id
      JOIN resource_events AS events ON events.id=heads.event_id
        AND events.resource_id=heads.resource_id
      WHERE events.lifecycle_state='active'
    ) SELECT type,id FROM candidates
    WHERE type_rank>@rank OR type_rank=@rank AND id>@id
    ORDER BY type_rank,id LIMIT 101
  `);
  const pageScalars = connection.prepare(`
    SELECT
      COALESCE(MAX(tabs.last_seen_at), '') AS last_seen_at,
      COALESCE(MAX(tabs.is_open), 0) AS is_open,
      COUNT(DISTINCT instances.id) AS physical_count,
      COALESCE(MAX(instances.pinned), 0) AS is_pinned,
      COUNT(DISTINCT CASE WHEN contents.text IS NOT NULL
        OR contents.summary IS NOT NULL THEN tabs.id END) AS captured_count,
      COUNT(DISTINCT CASE WHEN contents.summary IS NOT NULL
        AND length(trim(contents.summary)) > 0 THEN tabs.id END) AS current_summary_count
    FROM tabs
    LEFT JOIN tab_instances AS instances ON instances.tab_id = tabs.id
    LEFT JOIN contents ON contents.tab_id = tabs.id
    WHERE tabs.logical_page_id = ?
  `);
  const pageStatuses = connection.prepare(`
    SELECT DISTINCT status AS value FROM tabs WHERE logical_page_id = ?
    ORDER BY status LIMIT 10001
  `);
  const pageWorkspaces = connection.prepare(`
    SELECT DISTINCT trim(workspaces.name) AS value
    FROM tabs
    JOIN saved_workspace_items AS items ON items.canonical_tab_id = tabs.id
    JOIN saved_workspaces AS workspaces ON workspaces.id = items.workspace_id
    WHERE tabs.logical_page_id = ?
    ORDER BY value LIMIT 10001
  `);
  const pageTopics = connection.prepare(`
    WITH RECURSIVE topic_paths(id, path) AS (
      SELECT id, trim(name) FROM tags WHERE parent_id IS NULL
      UNION ALL
      SELECT child.id, parent.path || '/' || trim(child.name)
      FROM tags AS child JOIN topic_paths AS parent ON parent.id = child.parent_id
    )
    SELECT DISTINCT topic_paths.path AS value
    FROM tabs
    JOIN tab_tags ON tab_tags.tab_id = tabs.id
    JOIN topic_paths ON topic_paths.id = tab_tags.tag_id
    WHERE tabs.logical_page_id = ?
    ORDER BY value LIMIT 10001
  `);
  const pageTaggedTopicCount = connection.prepare(`
    SELECT COUNT(DISTINCT tab_tags.tag_id)
    FROM tabs JOIN tab_tags ON tab_tags.tab_id = tabs.id
    WHERE tabs.logical_page_id = ?
  `).pluck();
  const pageRelationCount = connection.prepare(`
    WITH page_entities AS (
      SELECT DISTINCT entities.id
      FROM tabs JOIN knowledge_entities AS entities
        ON entities.kind = 'tab' AND entities.tab_id = tabs.id
      WHERE tabs.logical_page_id = ?
    ), incident AS (
      SELECT relations.id FROM relations JOIN page_entities
        ON page_entities.id = relations.from_entity_id
      UNION
      SELECT relations.id FROM relations JOIN page_entities
        ON page_entities.id = relations.to_entity_id
    )
    SELECT COUNT(*) FROM incident
  `).pluck();
  const pageContext = connection.prepare(`
    SELECT
      EXISTS (
        SELECT 1 FROM context_entries AS entries
        WHERE entries.logical_page_id = @id
          AND entries.kind = 'next_action'
          AND entries.visibility = 'share_with_ai' AND entries.state = 'active'
          AND (entries.stale_at IS NULL OR julianday(entries.stale_at) > julianday(@anchor))
          AND NOT EXISTS (
            SELECT 1 FROM context_entries AS newer
            WHERE newer.supersedes_id = entries.id
              AND newer.visibility = 'share_with_ai'
          )
          AND (entries.actor = 'user' OR (entries.actor = 'agent' AND
            (SELECT COUNT(*) FROM context_entry_reviews AS reviews
             WHERE reviews.context_entry_id = entries.id
               AND NOT EXISTS (SELECT 1 FROM context_entry_reviews AS newer_review
                 WHERE newer_review.supersedes_id = reviews.id)) = 1
            AND EXISTS (SELECT 1 FROM context_entry_reviews AS reviews
             WHERE reviews.context_entry_id = entries.id AND reviews.verdict = 'accepted'
               AND NOT EXISTS (SELECT 1 FROM context_entry_reviews AS newer_review
                 WHERE newer_review.supersedes_id = reviews.id))))
      ) AS has_next_action,
      EXISTS (
        SELECT 1 FROM context_entries AS entries
        WHERE entries.logical_page_id = @id
          AND entries.kind = 'project'
          AND entries.visibility = 'share_with_ai' AND entries.state = 'active'
          AND (entries.stale_at IS NULL OR julianday(entries.stale_at) > julianday(@anchor))
          AND NOT EXISTS (
            SELECT 1 FROM context_entries AS newer
            WHERE newer.supersedes_id = entries.id
              AND newer.visibility = 'share_with_ai'
          )
          AND (entries.actor = 'user' OR (entries.actor = 'agent' AND
            (SELECT COUNT(*) FROM context_entry_reviews AS reviews
             WHERE reviews.context_entry_id = entries.id
               AND NOT EXISTS (SELECT 1 FROM context_entry_reviews AS newer_review
                 WHERE newer_review.supersedes_id = reviews.id)) = 1
            AND EXISTS (SELECT 1 FROM context_entry_reviews AS reviews
             WHERE reviews.context_entry_id = entries.id AND reviews.verdict = 'accepted'
               AND NOT EXISTS (SELECT 1 FROM context_entry_reviews AS newer_review
                 WHERE newer_review.supersedes_id = reviews.id))))
      ) AS has_project_context
  `);
  const pageResolution = connection.prepare(`
    SELECT events.id, events.logical_page_id, events.state, events.reason
    FROM resource_resolution_heads AS heads
    JOIN resource_resolution_events AS events
      ON events.id = heads.resolution_event_id
      AND events.logical_page_id = heads.logical_page_id
    WHERE heads.logical_page_id = ?
  `);
  const activityWriter = connection.prepare(`
    SELECT writer.state, writer.coverage_started_at, writer.updated_at,
      epochs.coverage_started_at AS availability_started_at
    FROM activity_daily_writer_state AS writer
    LEFT JOIN activity_tracking_epochs AS epochs
      ON epochs.metric = 'logical_page_activity_daily'
    WHERE writer.singleton_id = 1
  `);
  const pageActivity = connection.prepare(`
    SELECT COALESCE(SUM(foreground_ms), 0) AS foreground_ms,
      COALESCE(SUM(engaged_ms), 0) AS engaged_ms
    FROM logical_page_activity_daily
    WHERE logical_page_id = @id
      AND activity_date >= date(@anchor, '-29 days')
      AND activity_date < date(@anchor, '+1 day')
  `);
  const memberIds = connection.prepare(`
    SELECT DISTINCT assignments.logical_page_id AS id
    FROM logical_page_resource_heads AS heads
    JOIN logical_page_resource_assignments AS assignments
      ON assignments.id = heads.assignment_id
      AND assignments.logical_page_id = heads.logical_page_id
    WHERE assignments.action = 'assigned' AND assignments.resource_id = ?
    ORDER BY assignments.logical_page_id
  `);
  const resourceContext = connection.prepare(`
    SELECT
      EXISTS (
        SELECT 1 FROM resource_context_entries AS entries
        WHERE entries.resource_id = @id AND entries.kind = 'next_action'
          AND entries.visibility = 'share_with_ai' AND entries.state = 'active'
          AND (entries.stale_at IS NULL OR julianday(entries.stale_at) > julianday(@anchor))
          AND NOT EXISTS (SELECT 1 FROM resource_context_entries AS newer
            WHERE newer.supersedes_id = entries.id AND newer.visibility = 'share_with_ai')
          AND (entries.actor = 'user' OR (entries.actor = 'agent' AND
            (SELECT COUNT(*) FROM resource_context_entry_reviews AS reviews
             WHERE reviews.context_entry_id = entries.id
               AND NOT EXISTS (SELECT 1 FROM resource_context_entry_reviews AS newer_review
                 WHERE newer_review.supersedes_id = reviews.id)) = 1
            AND EXISTS (SELECT 1 FROM resource_context_entry_reviews AS reviews
             WHERE reviews.context_entry_id = entries.id AND reviews.verdict = 'accepted'
               AND NOT EXISTS (SELECT 1 FROM resource_context_entry_reviews AS newer_review
                 WHERE newer_review.supersedes_id = reviews.id))))
      ) AS has_next_action,
      EXISTS (
        SELECT 1 FROM resource_context_entries AS entries
        WHERE entries.resource_id = @id AND entries.kind = 'project'
          AND entries.visibility = 'share_with_ai' AND entries.state = 'active'
          AND (entries.stale_at IS NULL OR julianday(entries.stale_at) > julianday(@anchor))
          AND NOT EXISTS (SELECT 1 FROM resource_context_entries AS newer
            WHERE newer.supersedes_id = entries.id AND newer.visibility = 'share_with_ai')
          AND (entries.actor = 'user' OR (entries.actor = 'agent' AND
            (SELECT COUNT(*) FROM resource_context_entry_reviews AS reviews
             WHERE reviews.context_entry_id = entries.id
               AND NOT EXISTS (SELECT 1 FROM resource_context_entry_reviews AS newer_review
                 WHERE newer_review.supersedes_id = reviews.id)) = 1
            AND EXISTS (SELECT 1 FROM resource_context_entry_reviews AS reviews
             WHERE reviews.context_entry_id = entries.id AND reviews.verdict = 'accepted'
               AND NOT EXISTS (SELECT 1 FROM resource_context_entry_reviews AS newer_review
                 WHERE newer_review.supersedes_id = reviews.id))))
      ) AS has_project_context
  `);
  const resourceRelationCount = connection.prepare(`
    WITH members AS (
      SELECT DISTINCT assignments.logical_page_id
      FROM logical_page_resource_heads AS heads
      JOIN logical_page_resource_assignments AS assignments
        ON assignments.id = heads.assignment_id
        AND assignments.logical_page_id = heads.logical_page_id
      WHERE assignments.action = 'assigned' AND assignments.resource_id = ?
    ), entities AS (
      SELECT DISTINCT knowledge_entities.id
      FROM members JOIN tabs ON tabs.logical_page_id = members.logical_page_id
      JOIN knowledge_entities
        ON knowledge_entities.kind = 'tab' AND knowledge_entities.tab_id = tabs.id
    ), incident AS (
      SELECT relations.id FROM relations JOIN entities ON entities.id = relations.from_entity_id
      UNION
      SELECT relations.id FROM relations JOIN entities ON entities.id = relations.to_entity_id
    ) SELECT COUNT(*) FROM incident
  `).pluck();
  const resourceTopics = connection.prepare(`
    WITH RECURSIVE topic_paths(id, path) AS (
      SELECT id, trim(name) FROM tags WHERE parent_id IS NULL
      UNION ALL SELECT child.id, parent.path || '/' || trim(child.name)
      FROM tags AS child JOIN topic_paths AS parent ON parent.id = child.parent_id
    ), members AS (
      SELECT assignments.logical_page_id FROM logical_page_resource_heads AS heads
      JOIN logical_page_resource_assignments AS assignments
        ON assignments.id=heads.assignment_id
        AND assignments.logical_page_id=heads.logical_page_id
      WHERE assignments.action='assigned' AND assignments.resource_id=?
    ) SELECT DISTINCT topic_paths.path AS value FROM members
      JOIN tabs ON tabs.logical_page_id=members.logical_page_id
      JOIN tab_tags ON tab_tags.tab_id=tabs.id
      JOIN topic_paths ON topic_paths.id=tab_tags.tag_id ORDER BY value LIMIT 10001
  `);
  const resourceWorkspaces = connection.prepare(`
    WITH members AS (
      SELECT assignments.logical_page_id FROM logical_page_resource_heads AS heads
      JOIN logical_page_resource_assignments AS assignments
        ON assignments.id=heads.assignment_id
        AND assignments.logical_page_id=heads.logical_page_id
      WHERE assignments.action='assigned' AND assignments.resource_id=?
    ) SELECT DISTINCT trim(workspaces.name) AS value FROM members
      JOIN tabs ON tabs.logical_page_id=members.logical_page_id
      JOIN saved_workspace_items AS items ON items.canonical_tab_id=tabs.id
      JOIN saved_workspaces AS workspaces ON workspaces.id=items.workspace_id
      ORDER BY value LIMIT 10001
  `);
  const resourceStatuses = connection.prepare(`
    WITH members AS (
      SELECT assignments.logical_page_id FROM logical_page_resource_heads AS heads
      JOIN logical_page_resource_assignments AS assignments
        ON assignments.id=heads.assignment_id
        AND assignments.logical_page_id=heads.logical_page_id
      WHERE assignments.action='assigned' AND assignments.resource_id=?
    ) SELECT DISTINCT tabs.status AS value FROM members
      JOIN tabs ON tabs.logical_page_id=members.logical_page_id ORDER BY value LIMIT 10001
  `);
  const currentFeedbackVerdict = {
    page: connection.prepare(`
      SELECT verdict FROM priority_feedback WHERE logical_page_id = ? AND superseded_at IS NULL
    `),
    resource: connection.prepare(`
      SELECT verdict FROM resource_priority_feedback WHERE resource_id = ? AND superseded_at IS NULL
    `),
  } as const;
  const researchSchemaAvailable = connection.prepare(`
    SELECT 1 FROM sqlite_schema
    WHERE type = 'table' AND name = 'research_target_heads'
  `).pluck().get() === 1;
  const currentFreshResearchTargets = !researchSchemaAvailable
    ? undefined
    : connection.prepare(`
        WITH requested(target_key) AS (SELECT value FROM json_each(?))
        SELECT requested.target_key
        FROM requested
        JOIN research_target_heads AS heads
          ON heads.target_key = requested.target_key
        WHERE heads.current_fresh_report_id IS NOT NULL
        GROUP BY requested.target_key
      `);

  function currentResearchTargetKeys(
    subjects: readonly PrioritySubject[],
  ): ReadonlySet<string> {
    if (subjects.length === 0 || currentFreshResearchTargets === undefined) {
      return new Set();
    }
    const requested = JSON.stringify([...new Set(subjects.map(subjectKey))]);
    const rows = currentFreshResearchTargets.all(requested) as Array<{ target_key: string }>;
    return new Set(rows.map((row) => row.target_key));
  }

  function coverageAvailable(anchor: Date): boolean {
    const row = activityWriter.get() as ActivityWriterRow | undefined;
    if (row === undefined || row.availability_started_at === null ||
        row.state !== "enabled" || row.coverage_started_at === null) return false;
    let coverage: string;
    let updated: string;
    let availability: string;
    try {
      coverage = canonicalTimestamp(row.coverage_started_at, "activity coverage start");
      updated = canonicalTimestamp(row.updated_at, "activity writer update");
      availability = canonicalTimestamp(row.availability_started_at, "activity epoch");
    } catch {
      return false;
    }
    const windowStart = new Date(utcDayNumber(anchor) - 29 * 86_400_000);
    return coverage === updated && coverage >= availability &&
      new Date(coverage).getTime() <= windowStart.getTime() &&
      new Date(updated).getTime() <= anchor.getTime();
  }

  function contextSignals(
    statement: Database.Statement,
    id: number,
    at: string,
  ): { has_next_action: number; has_project_context: number } {
    const row = statement.get({ id, anchor: at }) as
      { has_next_action: number; has_project_context: number } | undefined;
    if (row === undefined || ![0, 1].includes(row.has_next_action) ||
        ![0, 1].includes(row.has_project_context)) {
      return storageCorrupt("Context projection is invalid");
    }
    return row;
  }

  function eligibilityFromResolutionRows(id: number, rows: readonly ResolutionRow[]): PriorityEligibility {
    if (rows.length === 0) {
      return {
        kind: "excluded",
        reason: "temporarily_unavailable",
        detail: { source: "eligibility", code: "missing_resource_resolution_head" },
      };
    }
    if (rows.length !== 1 || rows[0]!.logical_page_id !== id) {
      return storageCorrupt("Resource resolution head is invalid");
    }
    const canonicalReasons: Readonly<Record<string, ReadonlySet<string>>> = {
      overridden: new Set(["user_manual", "agent_on_behalf"]),
      matched: new Set(["explicit_alias", "system_seed", "registrable_domain"]),
      ambiguous: new Set(["authoritative_tie"]),
      unmatched: new Set(["weak_sensitive_signal", "registrable_domain_unavailable"]),
      excluded: new Set([
        "invalid_url", "browser_internal", "extension", "file", "data",
        "unsupported_scheme", "embedded_credentials", "localhost", "private_ip",
        "private_hostname",
      ]),
    };
    if (canonicalReasons[rows[0]!.state]?.has(rows[0]!.reason) !== true) {
      return {
        kind: "excluded",
        reason: "temporarily_unavailable",
        detail: { source: "eligibility", code: "corrupt_resource_resolution_head" },
      };
    }
    const reason = rows[0]!.reason;
    if (unsupportedResolutionReasons.has(reason)) {
      return { kind: "excluded", reason: "unsupported_url",
        detail: { source: "url_policy", code: reason } };
    }
    if (privateResolutionReasons.has(reason)) {
      return { kind: "excluded", reason: "private_or_internal",
        detail: { source: "url_policy", code: reason } };
    }
    return { kind: "eligible" };
  }

  function eligibilityForPage(id: number): PriorityEligibility {
    return eligibilityFromResolutionRows(id, pageResolution.all(id) as ResolutionRow[]);
  }

  function finishProjection(
    subject: PrioritySubject,
    at: string,
    rawFeatures: Record<string, boolean | number | readonly string[]>,
    rawEligibility: PriorityEligibility,
    options: {
      readonly outcome?: PriorityOutcome | null;
      readonly feedbackVerdict?: string | null;
      readonly ruleset?: PriorityRulesetRef;
    } = {},
  ): PriorityFeatureRead {
    const canonical = reducePriorityProjectionFacts(priorityProjectionFactsFromValues({
      subject, anchor: at, features: rawFeatures, eligibility: rawEligibility,
    }));
    const ruleset = options.ruleset ?? readActivePriorityRuleset(connection).ref;
    const currentOutcome = options.outcome === undefined
      ? engine.explain(subject) : options.outcome;
    const isCurrent = currentOutcomeMatches(
      currentOutcome,
      canonical.featureFingerprint,
      ruleset,
    );
    const id = subject.type === "page" ? subject.logicalPageId : subject.resourceId;
    const feedbackVerdict = options.feedbackVerdict === undefined
      ? (currentFeedbackVerdict[subject.type].get(id) as { verdict: string } | undefined)?.verdict
      : options.feedbackVerdict;
    const disagreement = feedbackVerdict !== undefined && feedbackVerdict !== null &&
      feedbackVerdict !== "accept";
    return {
      subject: canonical.subject,
      features: canonical.features,
      eligibility: canonical.eligibility,
      featureFingerprint: canonical.featureFingerprint,
      ruleset,
      desiredAssessmentMethod: "rule",
      currentOutcome,
      isCurrent,
      dirty: !isCurrent,
      needsReview: !isCurrent || outcomeNeedsReview(currentOutcome) || disagreement,
    };
  }

  function projectPage(
    id: number,
    at: string,
    anchor: Date,
    hasCurrentResearchReport: boolean,
  ) {
    const page = pageById.get(id) as PageRow | undefined;
    if (page === undefined) {
      throw new PriorityFeatureCatalogError(
        "PRIORITY_FEATURE_SUBJECT_NOT_FOUND",
        `Logical page ${id} was not found`,
      );
    }
    const scalar = pageScalars.get(id) as Record<string, unknown>;
    const topics = boundedStringSet(pageTopics.all(id) as StringValueRow[], "topic paths");
    const workspaces = boundedStringSet(
      pageWorkspaces.all(id) as StringValueRow[],
      "workspace names",
    );
    const statuses = boundedStringSet(pageStatuses.all(id) as StringValueRow[], "statuses");
    if (scalarCount(pageTaggedTopicCount.get(id), "tagged topic count") !==
        topics.values.length && topics.values.length < 10_001) {
      return storageCorrupt("Topic hierarchy is invalid");
    }
    const context = contextSignals(pageContext, id, at);
    const physicalCount = scalarCount(scalar.physical_count, "physical tab count");
    const featureValues: Record<string, boolean | number | readonly string[]> = {
      has_shareable_next_action: context.has_next_action === 1,
      has_shareable_project_context: context.has_project_context === 1,
      has_current_project_membership:
        (topics.values ?? []).some((value) => value === "Current projects" ||
          value.startsWith("Current projects/")) ||
        (workspaces.values ?? []).some((value) => value === "Current projects" ||
          value.startsWith("Current projects/")),
      ...(topics.values === undefined ? {} : { topic_paths: topics.values }),
      ...(workspaces.values === undefined ? {} : { workspace_names: workspaces.values }),
      ...(statuses.values === undefined ? {} : { status: statuses.values }),
      is_pinned: scalar.is_pinned === 1,
      is_open: scalar.is_open === 1,
      relation_count: scalarCount(pageRelationCount.get(id), "relation count"),
      age_days: utcDayDifference(anchor, page.created_at, "logical page creation"),
      last_seen_days: utcDayDifference(
        anchor,
        typeof scalar.last_seen_at === "string" && scalar.last_seen_at !== ""
          ? scalar.last_seen_at
          : page.updated_at,
        "logical page last observation",
      ),
      has_captured_content: scalarCount(scalar.captured_count, "captured count") > 0,
      has_current_summary: scalarCount(scalar.current_summary_count, "summary count") > 0,
      has_current_research_report: hasCurrentResearchReport,
      duplicate_physical_count: Math.max(0, physicalCount - 1),
    };
    if (coverageAvailable(anchor)) {
      const activity = pageActivity.get({ id, anchor: at }) as
        { foreground_ms: number; engaged_ms: number };
      featureValues.active_use_30d_ms = scalarCount(activity.engaged_ms, "engaged activity");
      featureValues.on_screen_30d_ms = scalarCount(activity.foreground_ms, "foreground activity");
    }
    return { subject: { type: "page" as const, logicalPageId: id },
      features: featureValues, eligibility: eligibilityForPage(id) };
  }

  function projectPagesBatch(
    ids: readonly number[],
    at: string,
    anchor: Date,
    currentResearchTargets: ReadonlySet<string>,
  ) {
    if (ids.length === 0) return new Map<number, ReturnType<typeof projectPage>>();
    const requested = JSON.stringify([...new Set(ids)]);
    const bases = connection.prepare(`WITH requested(id) AS (SELECT value FROM json_each(?))
      SELECT pages.id,pages.created_at,pages.updated_at FROM requested
      JOIN logical_pages AS pages ON pages.id=requested.id`).all(requested) as PageRow[];
    const baseById = new Map(bases.map((row) => [row.id, row]));
    for (const id of ids) if (!baseById.has(id)) {
      throw new PriorityFeatureCatalogError("PRIORITY_FEATURE_SUBJECT_NOT_FOUND",
        `Logical page ${id} was not found`);
    }
    const scalars = connection.prepare(`WITH requested(id) AS (SELECT value FROM json_each(?))
      SELECT requested.id,COALESCE(MAX(tabs.last_seen_at),'') AS last_seen_at,
        COALESCE(MAX(tabs.is_open),0) AS is_open,
        COUNT(DISTINCT instances.id) AS physical_count,
        COALESCE(MAX(instances.pinned),0) AS is_pinned,
        COUNT(DISTINCT CASE WHEN contents.text IS NOT NULL OR contents.summary IS NOT NULL
          THEN tabs.id END) AS captured_count,
        COUNT(DISTINCT CASE WHEN contents.summary IS NOT NULL
          AND length(trim(contents.summary))>0 THEN tabs.id END) AS current_summary_count
      FROM requested LEFT JOIN tabs ON tabs.logical_page_id=requested.id
      LEFT JOIN tab_instances AS instances ON instances.tab_id=tabs.id
      LEFT JOIN contents ON contents.tab_id=tabs.id GROUP BY requested.id`
    ).all(requested) as Array<Record<string, unknown> & { id: number }>;
    const scalarById = new Map(scalars.map((row) => [row.id, row]));
    function sets(sql: string, context: string) {
      const rows = connection.prepare(sql).all(requested) as Array<{ id: number; value: string }>;
      const grouped = new Map<number, StringValueRow[]>();
      for (const row of rows) {
        const values = grouped.get(row.id) ?? [];
        values.push({ value: row.value });
        grouped.set(row.id, values);
      }
      return new Map(ids.map((id) => [id,
        boundedStringSet(grouped.get(id) ?? [], context)]));
    }
    const statuses = sets(`WITH requested(id) AS (SELECT value FROM json_each(?)),
      values0 AS (SELECT DISTINCT tabs.logical_page_id AS id,tabs.status AS value FROM requested
        JOIN tabs ON tabs.logical_page_id=requested.id), ranked AS (
        SELECT *,row_number() OVER(PARTITION BY id ORDER BY value) AS rn FROM values0)
      SELECT id,value FROM ranked WHERE rn<=10001 ORDER BY id,value`, "statuses");
    const workspaces = sets(`WITH requested(id) AS (SELECT value FROM json_each(?)),
      values0 AS (SELECT DISTINCT tabs.logical_page_id AS id,trim(workspaces.name) AS value
      FROM requested
      JOIN tabs ON tabs.logical_page_id=requested.id
      JOIN saved_workspace_items AS items ON items.canonical_tab_id=tabs.id
      JOIN saved_workspaces AS workspaces ON workspaces.id=items.workspace_id), ranked AS (
        SELECT *,row_number() OVER(PARTITION BY id ORDER BY value) AS rn FROM values0)
      SELECT id,value FROM ranked WHERE rn<=10001 ORDER BY id,value`, "workspace names");
    const topics = sets(`WITH RECURSIVE requested(id) AS (SELECT value FROM json_each(?)),
      topic_paths(id,path) AS (SELECT id,trim(name) FROM tags WHERE parent_id IS NULL
        UNION ALL SELECT child.id,parent.path||'/'||trim(child.name) FROM tags AS child
        JOIN topic_paths AS parent ON parent.id=child.parent_id),
      values0 AS (SELECT DISTINCT tabs.logical_page_id AS id,topic_paths.path AS value FROM requested
      JOIN tabs ON tabs.logical_page_id=requested.id JOIN tab_tags ON tab_tags.tab_id=tabs.id
      JOIN topic_paths ON topic_paths.id=tab_tags.tag_id), ranked AS (
        SELECT *,row_number() OVER(PARTITION BY id ORDER BY value) AS rn FROM values0)
      SELECT id,value FROM ranked WHERE rn<=10001 ORDER BY id,value`,
    "topic paths");
    const taggedRows = connection.prepare(`WITH requested(id) AS (SELECT value FROM json_each(?))
      SELECT requested.id,COUNT(DISTINCT tab_tags.tag_id) AS count FROM requested
      LEFT JOIN tabs ON tabs.logical_page_id=requested.id
      LEFT JOIN tab_tags ON tab_tags.tab_id=tabs.id GROUP BY requested.id`
    ).all(requested) as Array<{ id: number; count: number }>;
    const taggedCounts = new Map(taggedRows.map((row) => [row.id, row.count]));
    const relationRows = connection.prepare(`WITH requested(id) AS (SELECT value FROM json_each(?)),
      entities(page_id,entity_id) AS (SELECT DISTINCT tabs.logical_page_id,knowledge_entities.id
        FROM requested JOIN tabs ON tabs.logical_page_id=requested.id
        JOIN knowledge_entities ON knowledge_entities.kind='tab'
          AND knowledge_entities.tab_id=tabs.id),
      incident(page_id,relation_id) AS (SELECT DISTINCT entities.page_id,relations.id
        FROM entities JOIN relations ON relations.from_entity_id=entities.entity_id
          OR relations.to_entity_id=entities.entity_id)
      SELECT page_id AS id,COUNT(*) AS count FROM incident GROUP BY page_id`
    ).all(requested) as Array<{ id: number; count: number }>;
    const relations = new Map(relationRows.map((row) => [row.id, row.count]));
    const contextRows = connection.prepare(`WITH requested(id) AS (SELECT value FROM json_each(?))
      SELECT requested.id,
      EXISTS(SELECT 1 FROM context_entries AS entries WHERE entries.logical_page_id=requested.id
        AND entries.kind='next_action' AND entries.visibility='share_with_ai'
        AND entries.state='active' AND (entries.stale_at IS NULL OR julianday(entries.stale_at)>julianday(?))
        AND NOT EXISTS(SELECT 1 FROM context_entries AS newer WHERE newer.supersedes_id=entries.id
          AND newer.visibility='share_with_ai') AND (entries.actor='user' OR entries.actor='agent'
          AND (SELECT COUNT(*) FROM context_entry_reviews AS reviews
            WHERE reviews.context_entry_id=entries.id AND NOT EXISTS(SELECT 1 FROM context_entry_reviews
              AS newer_review WHERE newer_review.supersedes_id=reviews.id))=1
          AND EXISTS(SELECT 1 FROM context_entry_reviews AS reviews
            WHERE reviews.context_entry_id=entries.id AND reviews.verdict='accepted'
              AND NOT EXISTS(SELECT 1 FROM context_entry_reviews AS newer_review
                WHERE newer_review.supersedes_id=reviews.id)))) AS has_next_action,
      EXISTS(SELECT 1 FROM context_entries AS entries WHERE entries.logical_page_id=requested.id
        AND entries.kind='project' AND entries.visibility='share_with_ai'
        AND entries.state='active' AND (entries.stale_at IS NULL OR julianday(entries.stale_at)>julianday(?))
        AND NOT EXISTS(SELECT 1 FROM context_entries AS newer WHERE newer.supersedes_id=entries.id
          AND newer.visibility='share_with_ai') AND (entries.actor='user' OR entries.actor='agent'
          AND (SELECT COUNT(*) FROM context_entry_reviews AS reviews
            WHERE reviews.context_entry_id=entries.id AND NOT EXISTS(SELECT 1 FROM context_entry_reviews
              AS newer_review WHERE newer_review.supersedes_id=reviews.id))=1
          AND EXISTS(SELECT 1 FROM context_entry_reviews AS reviews
            WHERE reviews.context_entry_id=entries.id AND reviews.verdict='accepted'
              AND NOT EXISTS(SELECT 1 FROM context_entry_reviews AS newer_review
                WHERE newer_review.supersedes_id=reviews.id)))) AS has_project_context
      FROM requested`).all(requested, at, at) as Array<{
        id: number; has_next_action: number; has_project_context: number }>;
    const contexts = new Map(contextRows.map((row) => [row.id, row]));
    const resolutionRows = connection.prepare(`WITH requested(id) AS (SELECT value FROM json_each(?))
      SELECT requested.id,events.logical_page_id,events.state,events.reason FROM requested
      LEFT JOIN resource_resolution_heads AS heads ON heads.logical_page_id=requested.id
      LEFT JOIN resource_resolution_events AS events ON events.id=heads.resolution_event_id
        AND events.logical_page_id=heads.logical_page_id`).all(requested) as ResolutionRow[];
    const resolutions = new Map<number, ResolutionRow[]>();
    for (const row of resolutionRows) {
      const rows = resolutions.get(row.id) ?? [];
      if (row.logical_page_id !== null) rows.push(row);
      resolutions.set(row.id, rows);
    }
    const activityRows = coverageAvailable(anchor) ? connection.prepare(`
      WITH requested(id) AS (SELECT value FROM json_each(?)) SELECT requested.id,
        COALESCE(SUM(activity.foreground_ms),0) AS foreground_ms,
        COALESCE(SUM(activity.engaged_ms),0) AS engaged_ms FROM requested
      LEFT JOIN logical_page_activity_daily AS activity ON activity.logical_page_id=requested.id
        AND activity.activity_date>=date(?,'-29 days') AND activity.activity_date<date(?,'+1 day')
      GROUP BY requested.id`).all(requested, at, at) as Array<{
        id: number; foreground_ms: number; engaged_ms: number }> : [];
    const activities = new Map(activityRows.map((row) => [row.id, row]));
    const result = new Map<number, ReturnType<typeof projectPage>>();
    for (const id of ids) {
      const page = baseById.get(id)!;
      const scalar = scalarById.get(id)!;
      const topicSet = topics.get(id)!;
      const workspaceSet = workspaces.get(id)!;
      const statusSet = statuses.get(id)!;
      const context = contexts.get(id)!;
      const physicalCount = scalarCount(scalar.physical_count, "physical tab count");
      if (scalarCount(taggedCounts.get(id), "tagged topic count") !== topicSet.values.length &&
          topicSet.values.length < 10_001) storageCorrupt("Topic hierarchy is invalid");
      const eligibilityRows = resolutions.get(id) ?? [];
      const eligibility = eligibilityFromResolutionRows(id, eligibilityRows);
      const featureValues: Record<string, boolean | number | readonly string[]> = {
        has_shareable_next_action: context.has_next_action === 1,
        has_shareable_project_context: context.has_project_context === 1,
        has_current_project_membership: topicSet.values.some((value) =>
          value === "Current projects" || value.startsWith("Current projects/")) ||
          workspaceSet.values.some((value) =>
            value === "Current projects" || value.startsWith("Current projects/")),
        topic_paths: topicSet.values, workspace_names: workspaceSet.values,
        status: statusSet.values, is_pinned: scalar.is_pinned === 1,
        is_open: scalar.is_open === 1, relation_count: relations.get(id) ?? 0,
        age_days: utcDayDifference(anchor, page.created_at, "logical page creation"),
        last_seen_days: utcDayDifference(anchor,
          typeof scalar.last_seen_at === "string" && scalar.last_seen_at !== ""
            ? scalar.last_seen_at : page.updated_at, "logical page last observation"),
        has_captured_content: scalarCount(scalar.captured_count, "captured count") > 0,
        has_current_summary: scalarCount(scalar.current_summary_count, "summary count") > 0,
        has_current_research_report: currentResearchTargets.has(`page:${id}`),
        duplicate_physical_count: Math.max(0, physicalCount - 1),
      };
      const activity = activities.get(id);
      if (activity !== undefined) {
        featureValues.active_use_30d_ms = scalarCount(activity.engaged_ms, "engaged activity");
        featureValues.on_screen_30d_ms = scalarCount(activity.foreground_ms, "foreground activity");
      }
      result.set(id, { subject: { type: "page", logicalPageId: id },
        features: featureValues, eligibility });
    }
    return result;
  }

  function projectResource(
    id: number,
    at: string,
    anchor: Date,
    hasCurrentResearchReport: boolean,
    pageCache?: ReadonlyMap<number, ReturnType<typeof projectPage>>,
  ) {
    const resource = resourceById.get(id) as ResourceRow | undefined;
    if (resource === undefined) {
      throw new PriorityFeatureCatalogError(
        "PRIORITY_FEATURE_SUBJECT_NOT_FOUND",
        `Resource ${id} was not found`,
      );
    }
    if (resource.lifecycle_state !== "active") {
      throw new PriorityFeatureCatalogError(
        "PRIORITY_FEATURE_RESOURCE_NOT_ACTIVE",
        `Resource ${id} is not currently active`,
      );
    }
    const ids = (memberIds.all(id) as Array<{ id: number }>).map((row) => row.id);
    const pages = ids.map((pageId) =>
      pageCache?.get(pageId) ?? projectPage(pageId, at, anchor, false));
    const topics = boundedStringSet(resourceTopics.all(id) as StringValueRow[], "topic_paths");
    const workspaces = boundedStringSet(
      resourceWorkspaces.all(id) as StringValueRow[], "workspace_names",
    );
    const statuses = boundedStringSet(
      resourceStatuses.all(id) as StringValueRow[], "status",
    );
    const context = contextSignals(resourceContext, id, at);
    const sum = (key: keyof PriorityFeatures) => pages.reduce((total, page) => {
      const value = page.features[key];
      return total + (typeof value === "number" ? value : 0);
    }, 0);
    const activityCovered = coverageAvailable(anchor);
    const featureValues: Record<string, boolean | number | readonly string[]> = {
      has_shareable_next_action: context.has_next_action === 1 ||
        pages.some((page) => page.features.has_shareable_next_action === true),
      has_shareable_project_context: context.has_project_context === 1 ||
        pages.some((page) => page.features.has_shareable_project_context === true),
      has_current_project_membership: pages.some((page) =>
        page.features.has_current_project_membership === true),
      ...(topics.values === undefined ? {} : { topic_paths: topics.values }),
      ...(workspaces.values === undefined ? {} : { workspace_names: workspaces.values }),
      ...(statuses.values === undefined ? {} : { status: statuses.values }),
      is_pinned: pages.some((page) => page.features.is_pinned === true),
      is_open: pages.some((page) => page.features.is_open === true),
      relation_count: scalarCount(resourceRelationCount.get(id), "resource relation count"),
      age_days: utcDayDifference(anchor, resource.created_at, "resource creation"),
      ...(pages.length === 0 ? {} : {
        last_seen_days: Math.min(...pages.map((page) =>
          page.features.last_seen_days as number)),
      }),
      has_captured_content: pages.some((page) => page.features.has_captured_content === true),
      has_current_summary: pages.some((page) => page.features.has_current_summary === true),
      has_current_research_report: hasCurrentResearchReport,
      duplicate_physical_count: sum("duplicate_physical_count"),
      resource_page_count: pages.length,
      resource_captured_page_count: pages.filter((page) =>
        page.features.has_captured_content === true).length,
      ...(activityCovered ? {
        active_use_30d_ms: sum("active_use_30d_ms"),
        on_screen_30d_ms: sum("on_screen_30d_ms"),
      } : {}),
    };
    return { subject: { type: "resource" as const, resourceId: id },
      features: featureValues, eligibility: { kind: "eligible" } as const };
  }

  function projectResourcesBatch(
    ids: readonly number[], at: string, anchor: Date,
    pages: ReadonlyMap<number, ReturnType<typeof projectPage>>,
    currentResearchTargets: ReadonlySet<string>,
  ) {
    if (ids.length === 0) return new Map<number, ReturnType<typeof projectResource>>();
    const requested = JSON.stringify([...new Set(ids)]);
    const resources = connection.prepare(`WITH requested(id) AS (SELECT value FROM json_each(?))
      SELECT resources.id,resources.created_at,events.lifecycle_state,events.access_class
      FROM requested JOIN resources ON resources.id=requested.id
      JOIN resource_heads AS heads ON heads.resource_id=resources.id
      JOIN resource_events AS events ON events.id=heads.event_id AND events.resource_id=heads.resource_id`
    ).all(requested) as ResourceRow[];
    const byId = new Map(resources.map((row) => [row.id, row]));
    for (const id of ids) {
      const row = byId.get(id);
      if (row === undefined) throw new PriorityFeatureCatalogError(
        "PRIORITY_FEATURE_SUBJECT_NOT_FOUND", `Resource ${id} was not found`);
      if (row.lifecycle_state !== "active") throw new PriorityFeatureCatalogError(
        "PRIORITY_FEATURE_RESOURCE_NOT_ACTIVE", `Resource ${id} is not currently active`);
    }
    const memberRows = connection.prepare(`WITH requested(id) AS (SELECT value FROM json_each(?))
      SELECT assignments.resource_id AS id,assignments.logical_page_id AS page_id FROM requested
      JOIN logical_page_resource_assignments AS assignments
        ON assignments.resource_id=requested.id AND assignments.action='assigned'
      JOIN logical_page_resource_heads AS heads
        ON heads.logical_page_id=assignments.logical_page_id AND heads.assignment_id=assignments.id`
    ).all(requested) as Array<{ id: number; page_id: number }>;
    const members = new Map<number, number[]>();
    for (const row of memberRows) {
      const value = members.get(row.id) ?? [];
      value.push(row.page_id); members.set(row.id, value);
    }
    function resourceSets(sql: string, context: string) {
      const rows = connection.prepare(sql).all(requested) as Array<{ id: number; value: string }>;
      const grouped = new Map<number, StringValueRow[]>();
      for (const row of rows) {
        const value = grouped.get(row.id) ?? []; value.push({ value: row.value });
        grouped.set(row.id, value);
      }
      return new Map(ids.map((id) => [id, boundedStringSet(grouped.get(id) ?? [], context)]));
    }
    const statuses = resourceSets(`WITH requested(id) AS (SELECT value FROM json_each(?)),
      values0 AS (SELECT DISTINCT assignments.resource_id AS id,tabs.status AS value
        FROM requested JOIN logical_page_resource_assignments AS assignments
          ON assignments.resource_id=requested.id AND assignments.action='assigned'
        JOIN logical_page_resource_heads AS heads ON heads.logical_page_id=assignments.logical_page_id
          AND heads.assignment_id=assignments.id
        JOIN tabs ON tabs.logical_page_id=assignments.logical_page_id), ranked AS (
        SELECT *,row_number() OVER(PARTITION BY id ORDER BY value) AS rn FROM values0)
      SELECT id,value FROM ranked WHERE rn<=10001 ORDER BY id,value`, "status");
    const topics = resourceSets(`WITH RECURSIVE requested(id) AS (SELECT value FROM json_each(?)),
      paths(id,path) AS (SELECT id,trim(name) FROM tags WHERE parent_id IS NULL UNION ALL
        SELECT child.id,parent.path||'/'||trim(child.name) FROM tags AS child
        JOIN paths AS parent ON parent.id=child.parent_id), values0 AS (
        SELECT DISTINCT assignments.resource_id AS id,paths.path AS value FROM requested
        JOIN logical_page_resource_assignments AS assignments
          ON assignments.resource_id=requested.id AND assignments.action='assigned'
        JOIN logical_page_resource_heads AS heads ON heads.logical_page_id=assignments.logical_page_id
          AND heads.assignment_id=assignments.id JOIN tabs ON tabs.logical_page_id=assignments.logical_page_id
        JOIN tab_tags ON tab_tags.tab_id=tabs.id JOIN paths ON paths.id=tab_tags.tag_id), ranked AS (
        SELECT *,row_number() OVER(PARTITION BY id ORDER BY value) AS rn FROM values0)
      SELECT id,value FROM ranked WHERE rn<=10001 ORDER BY id,value`, "topic_paths");
    const workspaces = resourceSets(`WITH requested(id) AS (SELECT value FROM json_each(?)),
      values0 AS (SELECT DISTINCT assignments.resource_id AS id,trim(workspaces.name) AS value
        FROM requested JOIN logical_page_resource_assignments AS assignments
          ON assignments.resource_id=requested.id AND assignments.action='assigned'
        JOIN logical_page_resource_heads AS heads ON heads.logical_page_id=assignments.logical_page_id
          AND heads.assignment_id=assignments.id JOIN tabs ON tabs.logical_page_id=assignments.logical_page_id
        JOIN saved_workspace_items AS items ON items.canonical_tab_id=tabs.id
        JOIN saved_workspaces AS workspaces ON workspaces.id=items.workspace_id), ranked AS (
        SELECT *,row_number() OVER(PARTITION BY id ORDER BY value) AS rn FROM values0)
      SELECT id,value FROM ranked WHERE rn<=10001 ORDER BY id,value`, "workspace_names");
    const contextRows = connection.prepare(`WITH requested(id) AS (SELECT value FROM json_each(?))
      SELECT requested.id,
      EXISTS(SELECT 1 FROM resource_context_entries AS e WHERE e.resource_id=requested.id
        AND e.kind='next_action' AND e.visibility='share_with_ai' AND e.state='active'
        AND (e.stale_at IS NULL OR julianday(e.stale_at)>julianday(?))
        AND NOT EXISTS(SELECT 1 FROM resource_context_entries AS n WHERE n.supersedes_id=e.id
          AND n.visibility='share_with_ai') AND (e.actor='user' OR e.actor='agent'
          AND (SELECT COUNT(*) FROM resource_context_entry_reviews AS r
            WHERE r.context_entry_id=e.id AND NOT EXISTS(SELECT 1 FROM resource_context_entry_reviews
              AS nr WHERE nr.supersedes_id=r.id))=1
          AND EXISTS(SELECT 1 FROM resource_context_entry_reviews AS r
            WHERE r.context_entry_id=e.id AND r.verdict='accepted'
              AND NOT EXISTS(SELECT 1 FROM resource_context_entry_reviews AS nr
                WHERE nr.supersedes_id=r.id)))) AS has_next_action,
      EXISTS(SELECT 1 FROM resource_context_entries AS e WHERE e.resource_id=requested.id
        AND e.kind='project' AND e.visibility='share_with_ai' AND e.state='active'
        AND (e.stale_at IS NULL OR julianday(e.stale_at)>julianday(?))
        AND NOT EXISTS(SELECT 1 FROM resource_context_entries AS n WHERE n.supersedes_id=e.id
          AND n.visibility='share_with_ai') AND (e.actor='user' OR e.actor='agent'
          AND (SELECT COUNT(*) FROM resource_context_entry_reviews AS r
            WHERE r.context_entry_id=e.id AND NOT EXISTS(SELECT 1 FROM resource_context_entry_reviews
              AS nr WHERE nr.supersedes_id=r.id))=1
          AND EXISTS(SELECT 1 FROM resource_context_entry_reviews AS r
            WHERE r.context_entry_id=e.id AND r.verdict='accepted'
              AND NOT EXISTS(SELECT 1 FROM resource_context_entry_reviews AS nr
                WHERE nr.supersedes_id=r.id)))) AS has_project_context FROM requested`
    ).all(requested, at, at) as Array<{ id: number; has_next_action: number;
      has_project_context: number }>;
    const contexts = new Map(contextRows.map((row) => [row.id, row]));
    const relationRows = connection.prepare(`WITH requested(id) AS (SELECT value FROM json_each(?)),
      members(resource_id,logical_page_id) AS (SELECT assignments.resource_id,
        assignments.logical_page_id FROM requested
        JOIN logical_page_resource_assignments AS assignments
          ON assignments.resource_id=requested.id AND assignments.action='assigned'
        JOIN logical_page_resource_heads AS heads ON heads.logical_page_id=assignments.logical_page_id
          AND heads.assignment_id=assignments.id), entities(resource_id,entity_id) AS (
        SELECT DISTINCT members.resource_id,knowledge_entities.id FROM members
        JOIN tabs ON tabs.logical_page_id=members.logical_page_id
        JOIN knowledge_entities ON knowledge_entities.kind='tab'
          AND knowledge_entities.tab_id=tabs.id), incident(resource_id,relation_id) AS (
        SELECT DISTINCT entities.resource_id,relations.id FROM entities JOIN relations
          ON relations.from_entity_id=entities.entity_id OR relations.to_entity_id=entities.entity_id)
      SELECT resource_id AS id,COUNT(*) AS count FROM incident GROUP BY resource_id`
    ).all(requested) as Array<{ id: number; count: number }>;
    const relations = new Map(relationRows.map((row) => [row.id, row.count]));
    const activityCovered = coverageAvailable(anchor);
    const result = new Map<number, ReturnType<typeof projectResource>>();
    for (const id of ids) {
      const resource = byId.get(id)!;
      const pageValues = (members.get(id) ?? []).map((pageId) => pages.get(pageId)!);
      const topicSet = topics.get(id)!; const workspaceSet = workspaces.get(id)!;
      const statusSet = statuses.get(id)!; const context = contexts.get(id)!;
      const sum = (key: keyof PriorityFeatures) => pageValues.reduce((total, page) => {
        const value = page.features[key]; return total + (typeof value === "number" ? value : 0);
      }, 0);
      const relationCount = scalarCount(relations.get(id) ?? 0, "resource relation count");
      const featureValues: Record<string, boolean | number | readonly string[]> = {
        has_shareable_next_action: context.has_next_action === 1 || pageValues.some((page) =>
          page.features.has_shareable_next_action === true),
        has_shareable_project_context: context.has_project_context === 1 || pageValues.some((page) =>
          page.features.has_shareable_project_context === true),
        has_current_project_membership: pageValues.some((page) =>
          page.features.has_current_project_membership === true),
        topic_paths: topicSet.values, workspace_names: workspaceSet.values, status: statusSet.values,
        is_pinned: pageValues.some((page) => page.features.is_pinned === true),
        is_open: pageValues.some((page) => page.features.is_open === true),
        relation_count: relationCount,
        age_days: utcDayDifference(anchor, resource.created_at, "resource creation"),
        ...(pageValues.length === 0 ? {} : { last_seen_days: Math.min(...pageValues.map((page) =>
          page.features.last_seen_days as number)) }),
        has_captured_content: pageValues.some((page) => page.features.has_captured_content === true),
        has_current_summary: pageValues.some((page) => page.features.has_current_summary === true),
        has_current_research_report: currentResearchTargets.has(`resource:${id}`),
        duplicate_physical_count: sum("duplicate_physical_count"),
        resource_page_count: pageValues.length,
        resource_captured_page_count: pageValues.filter((page) =>
          page.features.has_captured_content === true).length,
        ...(activityCovered ? { active_use_30d_ms: sum("active_use_30d_ms"),
          on_screen_30d_ms: sum("on_screen_30d_ms") } : {}),
      };
      result.set(id, { subject: { type: "resource", resourceId: id },
        features: featureValues, eligibility: { kind: "eligible" } });
    }
    return result;
  }

  function read(subjectValue: PrioritySubject, at: string): PriorityFeatureRead {
    const subject = normalizeSubject(subjectValue);
    const anchor = anchorDate(at);
    const currentResearchTargets = currentResearchTargetKeys([subject]);
    const hasCurrentResearchReport = currentResearchTargets.has(subjectKey(subject));
    const projected = subject.type === "page"
      ? projectPage(subject.logicalPageId, at, anchor, hasCurrentResearchReport)
      : projectResource(subject.resourceId, at, anchor, hasCurrentResearchReport);
    return finishProjection(projected.subject, at, projected.features, projected.eligibility);
  }

  function listSubjects(): readonly PrioritySubject[] {
    return [
      ...(allPageIds.all() as Array<{ id: number }>).map(({ id }) =>
        ({ type: "page" as const, logicalPageId: id })),
      ...(allActiveResourceIds.all() as Array<{ id: number }>).map(({ id }) =>
        ({ type: "resource" as const, resourceId: id })),
    ];
  }

  function listSubjectPage(input: {
    readonly after?: PrioritySubject;
    readonly limit: number;
  }) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new PriorityFeatureCatalogError(
        "PRIORITY_FEATURE_STORAGE_CORRUPT",
        "Priority subject page limit must be 1..100",
      );
    }
    const after = input.after === undefined ? null : normalizeSubject(input.after);
    const rank = after?.type === "resource" ? 1 : 0;
    const id = after === null ? 0 : after.type === "page"
      ? after.logicalPageId : after.resourceId;
    const rows = subjectsAfter.all({ rank, id }) as
      Array<{ type: "page" | "resource"; id: number }>;
    const pageRows = rows.slice(0, input.limit);
    const items = pageRows.map((row): PrioritySubject => row.type === "page"
      ? { type: "page", logicalPageId: row.id }
      : { type: "resource", resourceId: row.id });
    return {
      items,
      nextAfter: rows.length > input.limit ? items.at(-1)! : null,
    };
  }

    function projectedBatch(subjects: readonly PrioritySubject[], at: string) {
      if (!Array.isArray(subjects) || subjects.length > 100) {
        throw new PriorityFeatureCatalogError(
          "PRIORITY_FEATURE_STORAGE_CORRUPT",
          "Priority read batch must contain at most 100 subjects",
        );
      }
      const anchor = anchorDate(at);
      const normalized = subjects.map(normalizeSubject);
      const currentResearchTargets = currentResearchTargetKeys(normalized);
      const directPageIds = normalized.filter((subject) => subject.type === "page")
        .map((subject) => subject.logicalPageId);
      const resourceIds = normalized.filter((subject) => subject.type === "resource")
        .map((subject) => subject.resourceId);
      const resourceMembers = resourceIds.length === 0 ? [] : connection.prepare(`
        WITH requested(id) AS (SELECT value FROM json_each(?))
        SELECT assignments.resource_id,assignments.logical_page_id FROM requested
        JOIN logical_page_resource_assignments AS assignments
          ON assignments.resource_id=requested.id AND assignments.action='assigned'
        JOIN logical_page_resource_heads AS heads
          ON heads.logical_page_id=assignments.logical_page_id
            AND heads.assignment_id=assignments.id`).all(JSON.stringify(resourceIds)) as
        Array<{ resource_id: number; logical_page_id: number }>;
      const allPageIds = [...new Set([...directPageIds,
        ...resourceMembers.map((row) => row.logical_page_id)])];
      const directPages = projectPagesBatch(allPageIds, at, anchor, currentResearchTargets);
      const resourceProjects = projectResourcesBatch(
        resourceIds, at, anchor, directPages, currentResearchTargets,
      );
      return normalized.map((subject) => subject.type === "page"
        ? directPages.get(subject.logicalPageId)!
        : resourceProjects.get(subject.resourceId)!);
    }

    function previewBatch(subjects: readonly PrioritySubject[], at: string) {
      return projectedBatch(subjects, at).map((projected) =>
        canonicalPriorityFeatureProjection(projected));
    }

    function readBatch(subjects: readonly PrioritySubject[], at: string) {
      const normalized = subjects.map(normalizeSubject);
      const projected = projectedBatch(normalized, at);
      const outcomes = engine.explainBatch(normalized);
      const feedback = new Map<string, string>();
      for (const type of ["page", "resource"] as const) {
        const ids = [...new Set(normalized.filter((subject) => subject.type === type)
          .map((subject) => subject.type === "page"
            ? subject.logicalPageId : subject.resourceId))];
        if (ids.length === 0) continue;
        const table = type === "page" ? "priority_feedback" : "resource_priority_feedback";
        const column = type === "page" ? "logical_page_id" : "resource_id";
        const rows = connection.prepare(`SELECT ${column} AS id,verdict FROM ${table}
          WHERE ${column} IN (${ids.map(() => "?").join(",")}) AND superseded_at IS NULL`
        ).all(...ids) as Array<{ id: number; verdict: string }>;
        for (const row of rows) feedback.set(`${type}:${row.id}`, row.verdict);
      }
      const ruleset = readActivePriorityRuleset(connection).ref;
      return projected.map((value, index) => finishProjection(
        value.subject, at, value.features, value.eligibility, {
          outcome: outcomes[index]!, ruleset,
          feedbackVerdict: feedback.get(subjectKey(value.subject)) ?? null,
        },
      ));
  }

  return {
    read,
    readBatch,
    previewBatch,
    listSubjects,
    listSubjectPage,
    reviewQueue(input) {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
        throw new PriorityFeatureCatalogError(
          "PRIORITY_FEATURE_STORAGE_CORRUPT",
          "Priority review queue limit must be 1..100",
        );
      }
      const cursor = decodeCursor(input.cursor);
      const rank = cursor?.type === "resource" ? 1 : 0;
      const id = cursor === null ? 0 : cursor.type === "page"
        ? cursor.logicalPageId : cursor.resourceId;
      const candidateRows = subjectsAfter.all({ rank, id }) as
        Array<{ type: "page" | "resource"; id: number }>;
      const candidates = candidateRows.slice(0, 100).map((candidate): PrioritySubject =>
        candidate.type === "page"
          ? { type: "page", logicalPageId: candidate.id }
          : { type: "resource", resourceId: candidate.id });
      const projectedCandidates = readBatch(candidates, input.anchor);
      const items: PriorityFeatureRead[] = [];
      const scanned: Array<{ type: "page" | "resource"; id: number }> = [];
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidateRows[index]!;
        scanned.push(candidate);
        const projected = projectedCandidates[index]!;
        if (projected.needsReview) items.push(projected);
        if (items.length === input.limit) break;
      }
      const hasMore = scanned.length < candidateRows.length;
      return {
        items,
        nextCursor: hasMore && scanned.length > 0
          ? encodeCursor(scanned.at(-1)!.type === "page"
            ? { type: "page", logicalPageId: scanned.at(-1)!.id }
            : { type: "resource", resourceId: scanned.at(-1)!.id }) : null,
      };
    },
  };
}
