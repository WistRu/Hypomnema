import { createHash } from "node:crypto";

export const g0BaselineContractVersion = 1 as const;
export const g0BaselineSchemaVersion = 17 as const;

export interface BaselineHttpQuery {
  readonly id: string;
  readonly method: "GET";
  readonly pathTemplate: string;
}

export interface BoundBaselineHttpQuery extends BaselineHttpQuery {
  readonly audience: "local" | "public";
  readonly assertion:
    | "activity_exact_resource_totals"
    | "detail_exact_resource"
    | "library_exact_intersection_page"
    | "pages_exact_intersection_page"
    | "resource_list_exact_intersection_page";
}

export interface G6BaselineHttpQuery extends BaselineHttpQuery {
  readonly audience: "local" | "public";
  readonly assertion: "exact_page_ids_total" | "exact_resource_ids_total" |
    "exact_duplicate_boundary";
}

export interface SyntheticFixtureContract {
  readonly browsers: readonly string[];
  readonly closedEvery: number;
  readonly contentEvery: number;
  readonly crossBrowserLogicalPages: number;
  readonly duplicatePhysicalInstanceEvery: number;
  readonly rowCount: number;
  readonly seed: string;
  readonly topicCount: number;
}

export const q0LibraryV1 = Object.freeze([
  Object.freeze({
    id: "default-page",
    method: "GET",
    pathTemplate: "/api/tabs?page=1&pageSize=50",
  }),
  Object.freeze({
    id: "text-search",
    method: "GET",
    pathTemplate:
      "/api/tabs?q=baseline&search_mode=fulltext&page=1&pageSize=50",
  }),
  Object.freeze({
    id: "activity-sort-open-filter",
    method: "GET",
    pathTemplate:
      "/api/tabs?is_open=true&sort_by=activity&sort_direction=desc&page=1&pageSize=50",
  }),
  Object.freeze({
    id: "tab-detail",
    method: "GET",
    pathTemplate: "/api/tabs/:minimum-tab-id",
  }),
] satisfies readonly BaselineHttpQuery[]);

// Keep an independent immutable definition. Q0 and Q10K intentionally start
// with the same query shapes, but later versioning must never mutate both sets
// through a shared array reference.
export const q10kBaseV1 = Object.freeze([
  Object.freeze({
    id: "default-page",
    method: "GET",
    pathTemplate: "/api/tabs?page=1&pageSize=50",
  }),
  Object.freeze({
    id: "text-search",
    method: "GET",
    pathTemplate:
      "/api/tabs?q=baseline&search_mode=fulltext&page=1&pageSize=50",
  }),
  Object.freeze({
    id: "activity-sort-open-filter",
    method: "GET",
    pathTemplate:
      "/api/tabs?is_open=true&sort_by=activity&sort_direction=desc&page=1&pageSize=50",
  }),
  Object.freeze({
    id: "tab-detail",
    method: "GET",
    pathTemplate: "/api/tabs/:minimum-tab-id",
  }),
] satisfies readonly BaselineHttpQuery[]);

const q10kG3Queries = Object.freeze([
  Object.freeze({
    id: "resource-list-intersection",
    method: "GET",
    audience: "public",
    assertion: "resource_list_exact_intersection_page",
    pathTemplate:
      "/api/resources?browser=:browser&tag=:topic&page=1&pageSize=50&sort_by=activity&sort_direction=desc",
  }),
  Object.freeze({
    id: "resource-detail",
    method: "GET",
    audience: "public",
    assertion: "detail_exact_resource",
    pathTemplate: "/api/resources/:resource-id",
  }),
  Object.freeze({
    id: "resource-pages-intersection",
    method: "GET",
    audience: "public",
    assertion: "pages_exact_intersection_page",
    pathTemplate:
      "/api/resources/:resource-id/pages?tag=:topic&page=1&pageSize=50",
  }),
  Object.freeze({
    id: "resource-activity-all",
    method: "GET",
    audience: "public",
    assertion: "activity_exact_resource_totals",
    pathTemplate: "/api/resources/:resource-id/activity?window=all",
  }),
  Object.freeze({
    id: "library-resource-topic-intersection",
    method: "GET",
    audience: "local",
    assertion: "library_exact_intersection_page",
    pathTemplate:
      "/api/local/tabs?resource_id=:resource-id&tag=:topic&page=1&pageSize=50",
  }),
] satisfies readonly BoundBaselineHttpQuery[]);

/**
 * The complete executable G3 performance contract is hashed as one value.
 * Changing bindings, assertions, auth, feature flags or fixture derivation
 * creates a new version instead of silently changing Q10K-G3-v1.
 */
export const q10kG3V1 = Object.freeze({
  version: 1,
  querySet: "Q10K-G3-v1",
  fixture: Object.freeze({
    acceptedSource: "S10K-v1",
    acceptedSourceSha256:
      "d5cb2f53d3ba7bca7cf764b17ad7893536df5ffe29e131a65765848a5d71eefe",
    derivedFixture: "S10K-G3-v1",
    expectedSchemaVersion: 20,
    fixedClock: "2026-01-01T00:00:00.000Z",
  }),
  featureProfile: Object.freeze({
    context: true,
    logicalImportance: true,
    resources: true,
    priorityShadow: false,
    research: false,
  }),
  authProfile: Object.freeze({
    kind: "local_web_session",
    bootstrapOutsideTiming: true,
    sameSiteHeader: "same-origin",
  }),
  selector: Object.freeze({
    minimumHits: 1,
    requiredSensitivity: Object.freeze([
      "resource-list:browser",
      "resource-list:topic",
      "resource-pages:topic",
      "library:resource",
      "library:topic",
    ]),
    ordering: Object.freeze([
      "hit_count DESC",
      "resource_key ASC",
      "topic_path ASC",
      "browser ASC",
      "resource_id ASC",
    ]),
  }),
  assertions: Object.freeze({
    activity_exact_resource_totals:
      "resourceId, all-time sums, window and coverage exactly match independent SQL oracle",
    detail_exact_resource: "resource.id exactly matches selected resource",
    library_exact_intersection_page:
      "total and ordered tab IDs exactly match independent SQL oracle for every filter",
    pages_exact_intersection_page:
      "total and ordered logical-page IDs exactly match independent SQL oracle for every filter",
    resource_list_exact_intersection_page:
      "total and ordered resource IDs exactly match independent SQL oracle for every filter and sort",
  }),
  queries: q10kG3Queries,
  warmups: 3,
  samples: 20,
  p95LimitMs: 1_000,
});

export const s10kV1 = Object.freeze({
  browsers: Object.freeze(["chrome", "edge", "firefox"]),
  closedEvery: 3,
  contentEvery: 2,
  crossBrowserLogicalPages: 4_000,
  duplicatePhysicalInstanceEvery: 20,
  rowCount: 10_000,
  seed: "tabhub-s10k-v1",
  topicCount: 20,
} satisfies SyntheticFixtureContract);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function baselineContractHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export const baselineContractHashes = Object.freeze({
  q0LibraryV1: baselineContractHash(q0LibraryV1),
  q10kBaseV1: baselineContractHash(q10kBaseV1),
  s10kV1: baselineContractHash(s10kV1),
});

export const q10kG3V1Hash = baselineContractHash(q10kG3V1);

const q10kG6Queries = Object.freeze([
  Object.freeze({ id: "library-my-page-2", method: "GET", audience: "local",
    assertion: "exact_page_ids_total", pathTemplate:
      "/api/local/tabs?priority_mode=my&page=2&pageSize=50" }),
  Object.freeze({ id: "library-ai-page-2", method: "GET", audience: "local",
    assertion: "exact_page_ids_total", pathTemplate:
      "/api/local/tabs?priority_mode=ai&page=2&pageSize=50" }),
  Object.freeze({ id: "library-recommended-page-2", method: "GET", audience: "local",
    assertion: "exact_page_ids_total", pathTemplate:
      "/api/local/tabs?priority_mode=recommended&page=2&pageSize=50" }),
  Object.freeze({ id: "recommended-secondary-boundary-left", method: "GET",
    audience: "local", assertion: "exact_duplicate_boundary", pathTemplate:
      "/api/local/tabs?q=:boundary-url&priority_mode=recommended&sort_by=activity&sort_direction=desc&page=1&pageSize=1" }),
  Object.freeze({ id: "recommended-secondary-boundary-right", method: "GET",
    audience: "local", assertion: "exact_duplicate_boundary", pathTemplate:
      "/api/local/tabs?q=:boundary-url&priority_mode=recommended&sort_by=activity&sort_direction=desc&page=2&pageSize=1" }),
  Object.freeze({ id: "library-needs-review", method: "GET", audience: "local",
    assertion: "exact_page_ids_total", pathTemplate:
      "/api/local/tabs?needs_review=true&page=1&pageSize=50" }),
  Object.freeze({ id: "resource-my-page-1", method: "GET", audience: "public",
    assertion: "exact_resource_ids_total", pathTemplate:
      "/api/resources?priority_mode=my&page=1&pageSize=20" }),
  Object.freeze({ id: "resource-ai-page-2", method: "GET", audience: "public",
    assertion: "exact_resource_ids_total", pathTemplate:
      "/api/resources?priority_mode=ai&page=2&pageSize=20" }),
  Object.freeze({ id: "resource-recommended-page-3", method: "GET", audience: "public",
    assertion: "exact_resource_ids_total", pathTemplate:
      "/api/resources?priority_mode=recommended&page=3&pageSize=20" }),
  Object.freeze({ id: "resource-needs-review", method: "GET", audience: "public",
    assertion: "exact_resource_ids_total", pathTemplate:
      "/api/resources?needs_review=true&page=1&pageSize=20" }),
] satisfies readonly G6BaselineHttpQuery[]);

/** Immutable introducing-gate contract for priority ordering and pagination. */
export const q10kG6V1 = Object.freeze({
  version: 1,
  querySet: "Q10K-G6-v1",
  fixture: Object.freeze({
    acceptedSource: "S10K-v1",
    acceptedSourcePath:
      "D:\\VibeCoding\\TabHub\\.tmp\\personal-attention-layer\\g0-baseline-20260812T122100\\S10K-v1.sqlite",
    acceptedSourceSha256:
      "d5cb2f53d3ba7bca7cf764b17ad7893536df5ffe29e131a65765848a5d71eefe",
    derivedFixture: "S10K-G6-v1",
    expectedSchemaVersion: 23,
    fixedClock: "2026-01-01T00:00:00.000Z",
    preferenceSeed: "q10k-g6-preferences-v1",
    outcomeSeed: "q10k-g6-outcomes-v1-1",
    topicPartitionAlgorithm: "sorted-topic-path-index-modulo-10-v1",
    outcomePartitionAlgorithm:
      "sha256-seed-subject-modulo-3-with-lowest-id-per-evaluated-page-band-and-exclusion-promoted-current-v1",
    boundarySelectorAlgorithm:
      "minimum-unique-url-cross-browser-logical-page-activity-order-v1",
  }),
  derivationFeatureProfile: Object.freeze({
    activityDailyWriter: false, activityWindows: false, context: true,
    logicalImportance: true, resources: true, priorityAssessmentWriter: true,
    priorityPersonalization: true, priorityReaders: true, priorityShadow: false,
    research: false,
  }),
  measurementFeatureProfile: Object.freeze({
    activityDailyWriter: false, activityWindows: false, context: true,
    logicalImportance: true, resources: true, priorityAssessmentWriter: false,
    priorityPersonalization: true, priorityReaders: true, priorityShadow: false,
    research: false,
  }),
  authProfile: Object.freeze({ kind: "local_web_session",
    bootstrapOutsideTiming: true, sameSiteHeader: "same-origin" }),
  assertions: Object.freeze({
    exact_page_ids_total:
      "ordered physical tab IDs and total exactly match an independent raw-SQL oracle",
    exact_resource_ids_total:
      "ordered active Resource IDs and total exactly match an independent raw-SQL oracle",
    exact_duplicate_boundary:
      "two complete adjacent pages contain one cross-browser logical-page pair in secondary activity order",
    fullSweep:
      "all rows in the pinned filtered page sweep and all active Resources have no gaps/repeats; needs-review true/false are a disjoint full union",
    noninterference:
      "every SQLite table has the same dynamic row checksum before and after writer-off measurement",
  }),
  fullSweep: Object.freeze({ pageSize: 200, pageSearch: "Baseline page 00",
    pageModes: Object.freeze(["my", "ai", "recommended"]),
    reviewValues: Object.freeze([true, false]),
    resourceModes: Object.freeze(["my", "ai", "recommended"]) }),
  queries: q10kG6Queries,
  warmups: 3,
  samples: 20,
  p95LimitMs: 1_000,
});

export const q10kG6V1Hash = baselineContractHash(q10kG6V1);
