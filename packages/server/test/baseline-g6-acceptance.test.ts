import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { q10kG6V1, q10kG6V1Hash } from "../src/baseline-contract.js";
import { createSyntheticBaselineFixture } from "../src/baseline-database.js";
import { inspectG6Database } from "../src/baseline-g6-database.js";
import {
  runG6Baseline,
  runG6CandidateBaselineForTest,
  type G6BaselineResult,
  type G6SubjectCoverage,
  type G6SweepDetail,
} from "../src/baseline-g6-runner.js";
import { openDatabase } from "../src/database.js";
import { createPriorityFeatureCatalog } from "../src/priority-feature-catalog.js";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function independentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

async function fileSha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function directoryFingerprint(path: string) {
  const names = (await readdir(path)).sort();
  return Promise.all(names.map(async (name) => {
    const filePath = join(path, name);
    const metadata = await stat(filePath);
    return {
      mtimeMs: metadata.mtimeMs,
      name,
      sha256: await fileSha256(filePath),
      size: metadata.size,
    };
  }));
}

interface IndependentPriorityRow {
  readonly agentScore: number;
  readonly bandRank: number;
  readonly browser?: string;
  readonly id: number;
  readonly logicalPageId?: number;
  readonly name?: string;
  readonly needsReview: boolean;
  readonly resourceKey?: string;
  readonly title?: string | null;
  readonly url?: string;
  readonly userValue: number | null;
}

const independentBandRanks: Readonly<Record<string, number>> = {
  critical: 4,
  high: 3,
  low: 1,
  medium: 2,
};
const independentBrowserRanks: Readonly<Record<string, number>> = {
  chrome: 0,
  edge: 2,
  other: 3,
  yandex: 1,
};

function compareAcceptanceText(left: string, right: string): number {
  return left.localeCompare(right, "en", { sensitivity: "base" }) ||
    left.localeCompare(right);
}

function orderIndependentRows(
  rows: readonly IndependentPriorityRow[],
  type: "page" | "resource",
  mode: "my" | "ai" | "recommended" | undefined,
): IndependentPriorityRow[] {
  return [...rows].sort((left, right) => {
    if (mode === "my") {
      const importance = (right.userValue ?? 0) - (left.userValue ?? 0);
      if (importance !== 0) return importance;
    }
    if (mode === "ai") {
      const ai = right.bandRank - left.bandRank ||
        right.agentScore - left.agentScore;
      if (ai !== 0) return ai;
    }
    if (mode === "recommended") {
      const effectiveBand = (row: IndependentPriorityRow) =>
        row.userValue ?? row.bandRank;
      const recommended = effectiveBand(right) - effectiveBand(left) ||
        Number(right.userValue !== null) - Number(left.userValue !== null) ||
        right.agentScore - left.agentScore;
      if (recommended !== 0) return recommended;
    }
    if (type === "page") {
      const browser = (independentBrowserRanks[left.browser!] ?? 4) -
          (independentBrowserRanks[right.browser!] ?? 4) ||
        compareAcceptanceText(left.browser!, right.browser!);
      return browser || left.id - right.id;
    }
    const name = compareAcceptanceText(left.name!, right.name!);
    return name || compareAcceptanceText(left.resourceKey!, right.resourceKey!) ||
      left.id - right.id;
  });
}

function independentPriorityRows(databasePath: string) {
  const database = openDatabase(databasePath);
  try {
    const active = database.connection.prepare(`SELECT ruleset_id,version
      FROM priority_ruleset_activations WHERE scope='global'`).get() as {
        ruleset_id: number;
        version: number;
      };
    const pageAssessments = new Map((database.connection.prepare(`SELECT logical_page_id,
      agent_score,agent_band,needs_review FROM priority_assessments
      WHERE superseded_at IS NULL AND ruleset_id=? AND ruleset_version=?`).all(
      active.ruleset_id,
      active.version,
    ) as Array<{ agent_band: string; agent_score: number; logical_page_id: number;
      needs_review: number }>).map((row) => [row.logical_page_id, row]));
    const resourceAssessments = new Map((database.connection.prepare(`SELECT resource_id,
      agent_score,agent_band,needs_review FROM resource_priority_assessments
      WHERE superseded_at IS NULL AND ruleset_id=? AND ruleset_version=?`).all(
      active.ruleset_id,
      active.version,
    ) as Array<{ agent_band: string; agent_score: number; resource_id: number;
      needs_review: number }>).map((row) => [row.resource_id, row]));
    const pageRows = database.connection.prepare(`SELECT tabs.id,tabs.logical_page_id,
      tabs.browser,tabs.title,tabs.url,preferences.user_importance
      FROM tabs LEFT JOIN logical_page_preferences preferences
        ON preferences.logical_page_id=tabs.logical_page_id
      WHERE NOT EXISTS (SELECT 1 FROM page_retention
        WHERE page_retention.tab_id=tabs.id AND page_retention.state='trashed')`).all() as
      Array<{ browser: string; id: number; logical_page_id: number; title: string | null;
        url: string; user_importance: number | null }>;
    const resourceRows = database.connection.prepare(`SELECT resources.id,
      resources.resource_key,events.name,preferences.user_evaluation
      FROM resources JOIN resource_heads heads ON heads.resource_id=resources.id
      JOIN resource_events events ON events.id=heads.event_id
        AND events.resource_id=resources.id
      JOIN resource_preferences preferences ON preferences.resource_id=resources.id
      WHERE events.lifecycle_state='active'`).all() as Array<{ id: number; name: string;
        resource_key: string; user_evaluation: number | null }>;
    return {
      pages: pageRows.map((row): IndependentPriorityRow => {
        const assessment = pageAssessments.get(row.logical_page_id);
        return {
          agentScore: assessment?.agent_score ?? -1,
          bandRank: assessment === undefined ? 0 :
            independentBandRanks[assessment.agent_band]!,
          browser: row.browser,
          id: row.id,
          logicalPageId: row.logical_page_id,
          needsReview: assessment?.needs_review === 1,
          title: row.title,
          url: row.url,
          userValue: row.user_importance,
        };
      }),
      resources: resourceRows.map((row): IndependentPriorityRow => {
        const assessment = resourceAssessments.get(row.id);
        return {
          agentScore: assessment?.agent_score ?? -1,
          bandRank: assessment === undefined ? 0 :
            independentBandRanks[assessment.agent_band]!,
          id: row.id,
          name: row.name,
          needsReview: assessment?.needs_review === 1,
          resourceKey: row.resource_key,
          userValue: row.user_evaluation,
        };
      }),
    };
  } finally {
    database.close();
  }
}

function expectCompleteSweep(detail: G6SweepDetail): void {
  expect(detail.finalEmpty).toBe(true);
  expect(detail.ids).toHaveLength(detail.total);
  expect(new Set(detail.ids).size).toBe(detail.ids.length);
  expect(detail.fetchedPages).toBe(
    Math.ceil(detail.total / q10kG6V1.fullSweep.pageSize) + 1,
  );
}

function expectCoverageComplete(value: G6SubjectCoverage): void {
  expect(value.userValues).toEqual([null, 1, 2, 3]);
  expect(value.currentBands).toEqual(["critical", "high", "low", "medium"]);
  expect(value.currentExclusionCount).toBeGreaterThan(0);
  expect(value.currentReviewCount).toBeGreaterThan(0);
  expect(value.staleCount).toBeGreaterThan(0);
  expect(value.missingCount).toBeGreaterThan(0);
  expect(value.fingerprintMismatchCount).toBe(0);
}

function expectIndependentFullSweeps(
  databasePath: string,
  result: G6BaselineResult,
): void {
  const rows = independentPriorityRows(databasePath);
  const needle = q10kG6V1.fullSweep.pageSearch.toLocaleLowerCase("en-US");
  const pages = rows.pages.filter((row) =>
    (row.title ?? row.url ?? "").toLocaleLowerCase("en-US").includes(needle) ||
    (row.url ?? "").toLocaleLowerCase("en-US").includes(needle));
  expect(pages.length).toBeGreaterThan(0);
  expect(pages.length).toBeLessThan(rows.pages.length);

  for (const mode of ["my", "ai", "recommended"] as const) {
    expect(result.fullSweep.pages[mode]!.ids).toEqual(
      orderIndependentRows(pages, "page", mode).map(({ id }) => id),
    );
    expect(result.fullSweep.resources[mode]!.ids).toEqual(
      orderIndependentRows(rows.resources, "resource", mode).map(({ id }) => id),
    );
  }
  for (const value of [true, false]) {
    expect(result.fullSweep.pages[`review-${value}`]!.ids).toEqual(
      orderIndependentRows(
        pages.filter((row) => row.needsReview === value),
        "page",
        undefined,
      ).map(({ id }) => id),
    );
    expect(result.fullSweep.resources[`review-${value}`]!.ids).toEqual(
      orderIndependentRows(
        rows.resources.filter((row) => row.needsReview === value),
        "resource",
        undefined,
      ).map(({ id }) => id),
    );
  }
}

function expectCurrentFeatureFingerprints(databasePath: string): void {
  const database = openDatabase(databasePath, {
    maximumMigrationVersion: q10kG6V1.fixture.expectedSchemaVersion,
  });
  try {
    const rows = database.connection.prepare(`WITH active AS (
      SELECT ruleset_id,version FROM priority_ruleset_activations WHERE scope='global'
    )
    SELECT 'page' AS type,outcomes.logical_page_id AS subject_id,
      outcomes.feature_fingerprint
      FROM priority_assessments outcomes,active WHERE outcomes.superseded_at IS NULL
        AND outcomes.ruleset_id=active.ruleset_id
        AND outcomes.ruleset_version=active.version
    UNION ALL
    SELECT 'page',outcomes.logical_page_id,outcomes.feature_fingerprint
      FROM priority_exclusions outcomes,active WHERE outcomes.superseded_at IS NULL
        AND outcomes.ruleset_id=active.ruleset_id
        AND outcomes.ruleset_version=active.version
    UNION ALL
    SELECT 'resource',outcomes.resource_id,outcomes.feature_fingerprint
      FROM resource_priority_assessments outcomes,active
      WHERE outcomes.superseded_at IS NULL
        AND outcomes.ruleset_id=active.ruleset_id
        AND outcomes.ruleset_version=active.version
    UNION ALL
    SELECT 'resource',outcomes.resource_id,outcomes.feature_fingerprint
      FROM resource_priority_exclusions outcomes,active
      WHERE outcomes.superseded_at IS NULL
        AND outcomes.ruleset_id=active.ruleset_id
        AND outcomes.ruleset_version=active.version
    ORDER BY type,subject_id`).all() as Array<{ feature_fingerprint: string;
      subject_id: number; type: "page" | "resource" }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => `${row.type}:${row.subject_id}`)).size)
      .toBe(rows.length);
    expect(new Set(rows.map(({ type }) => type))).toEqual(new Set(["page", "resource"]));

    const features = createPriorityFeatureCatalog(database.connection);
    for (let offset = 0; offset < rows.length; offset += 100) {
      const batch = rows.slice(offset, offset + 100);
      const projected = features.previewBatch(batch.map((row) => row.type === "page"
        ? { type: "page" as const, logicalPageId: row.subject_id }
        : { type: "resource" as const, resourceId: row.subject_id }),
      q10kG6V1.fixture.fixedClock);
      expect(projected.map(({ featureFingerprint }) => featureFingerprint)).toEqual(
        batch.map(({ feature_fingerprint }) => feature_fingerprint),
      );
    }
  } finally {
    database.close();
  }
}

const exactMeasuredQueries = [
  ["library-my-page-2", "local", "exact_page_ids_total",
    "/api/local/tabs?priority_mode=my&page=2&pageSize=50"],
  ["library-ai-page-2", "local", "exact_page_ids_total",
    "/api/local/tabs?priority_mode=ai&page=2&pageSize=50"],
  ["library-recommended-page-2", "local", "exact_page_ids_total",
    "/api/local/tabs?priority_mode=recommended&page=2&pageSize=50"],
  ["recommended-secondary-boundary-left", "local", "exact_duplicate_boundary",
    "/api/local/tabs?q=:boundary-url&priority_mode=recommended&sort_by=activity&sort_direction=desc&page=1&pageSize=1"],
  ["recommended-secondary-boundary-right", "local", "exact_duplicate_boundary",
    "/api/local/tabs?q=:boundary-url&priority_mode=recommended&sort_by=activity&sort_direction=desc&page=2&pageSize=1"],
  ["library-needs-review", "local", "exact_page_ids_total",
    "/api/local/tabs?needs_review=true&page=1&pageSize=50"],
  ["resource-my-page-1", "public", "exact_resource_ids_total",
    "/api/resources?priority_mode=my&page=1&pageSize=20"],
  ["resource-ai-page-2", "public", "exact_resource_ids_total",
    "/api/resources?priority_mode=ai&page=2&pageSize=20"],
  ["resource-recommended-page-3", "public", "exact_resource_ids_total",
    "/api/resources?priority_mode=recommended&page=3&pageSize=20"],
  ["resource-needs-review", "public", "exact_resource_ids_total",
    "/api/resources?needs_review=true&page=1&pageSize=20"],
] as const;

describe("Q10K-G6-v1 independent contract acceptance", () => {
  it("pins the complete deeply immutable contract and independent hash", () => {
    expect(q10kG6V1Hash)
      .toBe("01fe14e227f50a1124eff7da275d613199992d3127942f023e495c37b7c05cb5");
    expect(independentHash(q10kG6V1)).toBe(q10kG6V1Hash);
    expectDeepFrozen(q10kG6V1);
    expect(q10kG6V1).toMatchObject({
      version: 1,
      querySet: "Q10K-G6-v1",
      fixture: {
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
      },
      warmups: 3,
      samples: 20,
      p95LimitMs: 1_000,
    });
    expect(q10kG6V1.derivationFeatureProfile).toEqual({
      activityDailyWriter: false,
      activityWindows: false,
      context: true,
      logicalImportance: true,
      resources: true,
      priorityAssessmentWriter: true,
      priorityPersonalization: true,
      priorityReaders: true,
      priorityShadow: false,
      research: false,
    });
    expect(q10kG6V1.measurementFeatureProfile).toEqual({
      ...q10kG6V1.derivationFeatureProfile,
      priorityAssessmentWriter: false,
    });
  });

  it("pins ten measured queries and keeps every non-boundary measurement full-corpus", () => {
    expect(q10kG6V1.queries.map((query) => [
      query.id, query.audience, query.assertion, query.pathTemplate,
    ])).toEqual(exactMeasuredQueries);
    expect(new Set(q10kG6V1.queries.map(({ id }) => id)).size).toBe(10);

    for (const query of q10kG6V1.queries) {
      const url = new URL(query.pathTemplate, "https://acceptance.invalid");
      const keys = [...url.searchParams.keys()];
      const isBoundary = query.assertion === "exact_duplicate_boundary";
      expect(keys.includes("q"), query.id).toBe(isBoundary);
      for (const narrowingKey of [
        "browser", "status", "importance", "tag", "resource_id", "kind",
        "accessClass", "lifecycleState",
      ]) {
        expect(keys, `${query.id} must not narrow by ${narrowingKey}`)
          .not.toContain(narrowingKey);
      }
    }
  });

  it("separates the pinned filtered page sweep from the full active-Resource sweep", () => {
    expect(q10kG6V1.fullSweep).toEqual({
      pageSize: 200,
      pageSearch: "Baseline page 00",
      pageModes: ["my", "ai", "recommended"],
      reviewValues: [true, false],
      resourceModes: ["my", "ai", "recommended"],
    });
    expect(q10kG6V1.assertions.fullSweep).toBe(
      "all rows in the pinned filtered page sweep and all active Resources have no gaps/repeats; needs-review true/false are a disjoint full union",
    );
    expect(q10kG6V1.assertions.noninterference).toContain("every SQLite table");
  });

  it("pins the official CLI and keeps the runner oracle separate from production ordering", async () => {
    const packageJson = JSON.parse(await readFile(
      new URL("../package.json", import.meta.url),
      "utf8",
    )) as { scripts?: Record<string, string> };
    const cliSource = await readFile(
      new URL("../src/baseline-g6-cli.ts", import.meta.url),
      "utf8",
    );
    const runnerSource = await readFile(
      new URL("../src/baseline-g6-runner.ts", import.meta.url),
      "utf8",
    );

    expect(packageJson.scripts?.["baseline:g6"]).toBe("tsx src/baseline-g6-cli.ts");
    expect(cliSource).toContain("runG6Baseline");
    expect(cliSource).not.toContain("runG6CandidateBaselineForTest");
    expect(cliSource).toContain("q10kG6V1.fixture.acceptedSourcePath");
    expect(cliSource).toContain('argument === "--source"');
    expect(cliSource).toContain('argument === "--work-dir"');
    expect(cliSource).toContain("workDirectoryRetained: true");

    expect(runnerSource).toContain("function oracleRows(");
    expect(runnerSource).toContain("function orderOracle(");
    expect(runnerSource).toContain("differs from raw-SQL oracle");
    expect(runnerSource).not.toMatch(/from ["']\.\/priority-list-ordering/);
    expect(runnerSource).not.toMatch(/from ["']\.\/tab-list-sort/);
  });

  it("fingerprints the discovered application-table set instead of a fixed allowlist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-g6-dynamic-tables-"));
    const path = join(directory, "fixture.sqlite");
    try {
      const database = openDatabase(path, {
        migrationClock: () => new Date(q10kG6V1.fixture.fixedClock),
      });
      database.connection.exec(`
        CREATE TABLE acceptance_future_table (
          key TEXT PRIMARY KEY,
          payload BLOB NOT NULL
        );
        INSERT INTO acceptance_future_table (key,payload) VALUES ('one',X'00ff')
      `);
      database.close();

      const first = await inspectG6Database(path);
      expect(first.tables.acceptance_future_table).toMatchObject({ rowCount: 1 });
      expect(Object.keys(first.tables)).toContain("acceptance_future_table");

      const reopened = openDatabase(path);
      reopened.connection.prepare(`INSERT INTO acceptance_future_table (key,payload)
        VALUES (?,?)`).run("two", Buffer.from([1, 2, 3]));
      reopened.close();
      const second = await inspectG6Database(path);
      expect(second.tables.acceptance_future_table).toMatchObject({ rowCount: 2 });
      expect(second.tables.acceptance_future_table!.checksumSha256)
        .not.toBe(first.tables.acceptance_future_table!.checksumSha256);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects wrong official paths, wrong source hashes, and occupied workdirs without mutation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-g6-rejections-"));
    const sourcePath = join(directory, "candidate.sqlite");
    try {
      await createSyntheticBaselineFixture(sourcePath, { rowCount: 40 });
      const sourceHash = await fileSha256(sourcePath);
      const sourceBefore = await stat(sourcePath);

      const officialWork = join(directory, "official-must-not-exist");
      await expect(runG6Baseline({ sourcePath, workDirectory: officialWork }))
        .rejects.toThrow("Q10K-G6 accepted source path mismatch");
      await expect(access(officialWork)).rejects.toThrow();

      const hashWork = join(directory, "hash-must-not-exist");
      await expect(runG6CandidateBaselineForTest({
        expectedSourceSha256: "0".repeat(64),
        sourcePath,
        workDirectory: hashWork,
      })).rejects.toThrow("Q10K-G6 source SHA-256 mismatch");
      await expect(access(hashWork)).rejects.toThrow();

      const occupiedWork = join(directory, "occupied");
      await mkdir(occupiedWork);
      const markerPath = join(occupiedWork, "keep.txt");
      await writeFile(markerPath, "acceptance-owned\n", { flag: "wx" });
      const occupiedBefore = await directoryFingerprint(occupiedWork);
      await expect(runG6CandidateBaselineForTest({
        expectedSourceSha256: sourceHash,
        sourcePath,
        workDirectory: occupiedWork,
      })).rejects.toThrow("G6 baseline work directory must be empty");
      expect(await directoryFingerprint(occupiedWork)).toEqual(occupiedBefore);

      expect(await fileSha256(sourcePath)).toBe(sourceHash);
      expect((await stat(sourcePath)).mtimeMs).toBe(sourceBefore.mtimeMs);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 120_000);

  it("accepts a disposable 1K end-to-end run with independent sweeps and current fingerprints", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-g6-acceptance-1k-"));
    const sourcePath = join(directory, "S1K-candidate.sqlite");
    const workDirectory = join(directory, "work");
    try {
      await createSyntheticBaselineFixture(sourcePath, { rowCount: 1_000 });
      const sourceHash = await fileSha256(sourcePath);
      const sourceBefore = await stat(sourcePath);
      const result = await runG6CandidateBaselineForTest({
        expectedSourceSha256: sourceHash,
        sourcePath,
        workDirectory,
      });

      expect(result.official).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.correctnessPassed).toBe(true);
      expect(result.performancePassed).toBe(true);
      expect(result.querySet).toBe("Q10K-G6-candidate");
      expect(result.contractHash).toBe(independentHash({
        ...q10kG6V1,
        fixture: result.fixture,
        querySet: result.querySet,
      }));
      expect(result.featureProfile).toEqual(q10kG6V1.measurementFeatureProfile);
      expect(result.queries.map(({ id, path, samples }) => ({ id, path, samples })))
        .toEqual(q10kG6V1.queries.map((query) => ({
          id: query.id,
          path: query.pathTemplate.includes(":boundary-url")
            ? expect.stringContaining("priority_mode=recommended")
            : query.pathTemplate,
          samples: q10kG6V1.samples,
        })));
      expect(result.queries.every(({ passed, p95LimitMs }) =>
        passed && p95LimitMs === q10kG6V1.p95LimitMs)).toBe(true);

      expect(result.fixtureCoverage.passed).toBe(true);
      expectCoverageComplete(result.fixtureCoverage.page);
      expectCoverageComplete(result.fixtureCoverage.resource);
      expect(result.duplicateBoundary.complete).toBe(true);
      expect(result.duplicateBoundary.expectedTabIds).toHaveLength(2);

      expect(result.fullSweep.passed).toBe(true);
      expect(Object.keys(result.fullSweep.pages).sort()).toEqual([
        "ai", "my", "recommended", "review-false", "review-true",
      ]);
      expect(Object.keys(result.fullSweep.resources).sort()).toEqual([
        "ai", "my", "recommended", "review-false", "review-true",
      ]);
      for (const detail of [
        ...Object.values(result.fullSweep.pages),
        ...Object.values(result.fullSweep.resources),
      ]) expectCompleteSweep(detail);
      expect(result.fullSweep.pages["review-true"]!.total +
        result.fullSweep.pages["review-false"]!.total)
        .toBe(result.fullSweep.pages.my!.total);
      expect(result.fullSweep.resources["review-true"]!.total +
        result.fullSweep.resources["review-false"]!.total)
        .toBe(result.fullSweep.resources.my!.total);

      const primaryPath = join(workDirectory, "S10K-G6-v1.sqlite");
      const measurementPath = join(workDirectory, "S10K-G6-v1-measurement.sqlite");
      expectIndependentFullSweeps(measurementPath, result);
      expectCurrentFeatureFingerprints(primaryPath);

      expect(result.databaseDeterminism.exactMatch).toBe(true);
      expect(result.databaseDeterminism.primary).toEqual(result.databaseDeterminism.replica);
      expect(result.databaseDeterminism.primary.schemaVersion).toBe(23);
      expect(result.databaseDeterminism.primary.schemaVersion)
        .toBe(q10kG6V1.fixture.expectedSchemaVersion);
      expect(result.databaseDeterminism.primary.integrityCheck).toEqual(["ok"]);
      expect(result.databaseDeterminism.primary.foreignKeyViolationCount).toBe(0);
      expect(result.measurementNoninterference).toBe(true);
      expect(result.measurementAfter).toEqual(result.measurementBefore);
      expect(Object.keys(result.measurementBefore.tables).length).toBeGreaterThan(0);

      expect(result.source.unchanged).toBe(true);
      expect(result.source.beforeSha256).toBe(sourceHash);
      expect(result.source.afterSha256).toBe(sourceHash);
      expect(await fileSha256(sourcePath)).toBe(sourceHash);
      expect((await stat(sourcePath)).mtimeMs).toBe(sourceBefore.mtimeMs);

      const artifactPath = join(workDirectory, "Q10K-G6-candidate.json");
      expect(JSON.parse(await readFile(artifactPath, "utf8"))).toEqual(result);
      const workNames = (await readdir(workDirectory)).sort();
      expect(workNames).toEqual(expect.arrayContaining([
        ".g6-baseline-claimed",
        "Q10K-G6-candidate.json",
        "S10K-G6-v1-measurement.sqlite",
        "S10K-G6-v1-replica.sqlite",
        "S10K-G6-v1.sqlite",
      ]));
      expect(workNames.some((name) => name.endsWith(".tmp"))).toBe(false);

      const beforeRetry = await directoryFingerprint(workDirectory);
      await expect(runG6CandidateBaselineForTest({
        expectedSourceSha256: sourceHash,
        sourcePath,
        workDirectory,
      })).rejects.toThrow("G6 baseline work directory must be empty");
      expect(await directoryFingerprint(workDirectory)).toEqual(beforeRetry);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 120_000);
});
