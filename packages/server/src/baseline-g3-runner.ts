import { execFileSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import Database from "better-sqlite3";

import {
  localTabListResponseSchema,
  resourceActivityResponseSchema,
  resourceDetailSchema,
  resourceListResponseSchema,
  resourcePagesResponseSchema,
} from "@tabhub/shared";

import {
  baselineContractHash,
  q10kG3V1,
  q10kG3V1Hash,
  type BoundBaselineHttpQuery,
} from "./baseline-contract.js";
import {
  checkpointDatabase,
  inspectG3Database,
  inspectTopicFingerprints,
  sha256DatabaseFile,
  type G3DatabaseFingerprint,
} from "./baseline-g3-database.js";
import { createApp } from "./app.js";

export interface G3SelectorBinding {
  readonly browser: string;
  readonly hitCount: number;
  readonly resourceId: number;
  readonly resourceKey: string;
  readonly topic: string;
}

export interface G3QueryTiming {
  readonly id: string;
  readonly maxMs: number;
  readonly p50Ms: number;
  readonly p95LimitMs: number;
  readonly p95Ms: number;
  readonly passed: boolean;
  readonly path: string;
  readonly samples: number;
}

export interface G3BaselineResult {
  readonly contractHash: string;
  readonly databaseDeterminism: Readonly<{
    primary: G3DatabaseFingerprint;
    replica: G3DatabaseFingerprint;
    exactMatch: boolean;
  }>;
  readonly featureProfile: typeof q10kG3V1.featureProfile;
  readonly fixture: G3FixtureIdentity;
  readonly measurementDatabase: G3DatabaseFingerprint;
  readonly official: boolean;
  readonly passed: boolean;
  readonly performancePassed: boolean;
  readonly queries: readonly G3QueryTiming[];
  readonly querySet: string;
  readonly runtime: Readonly<{
    command: readonly string[];
    head: string;
    node: string;
    platform: NodeJS.Platform;
  }>;
  readonly selector: Readonly<{
    binding: G3SelectorBinding;
    contract: typeof q10kG3V1.selector;
  }>;
  readonly source: Readonly<{
    afterSha256: string;
    beforeMtimeMs: number;
    beforeSha256: string;
    path: string;
    topicFingerprints: ReturnType<typeof inspectTopicFingerprints>;
    unchanged: boolean;
  }>;
  readonly topicPreservation: Readonly<{
    measurementMatchesSource: boolean;
    primaryMatchesSource: boolean;
    replicaMatchesSource: boolean;
  }>;
  readonly warmups: number;
}

export interface RunG3BaselineOptions {
  readonly sourcePath: string;
  readonly workDirectory: string;
}

interface G3ExpectedOutcomes {
  readonly activity: Readonly<{
    activeUseMs: number;
    coverageStart: string | null;
    onScreenMs: number;
    resourceId: number;
    window: "all";
    windowEnd: string;
    windowStart: string | null;
  }>;
  readonly library: Readonly<{ ids: readonly number[]; total: number }>;
  readonly pages: Readonly<{ ids: readonly number[]; total: number }>;
  readonly resources: Readonly<{ ids: readonly number[]; total: number }>;
}

interface G3FixtureIdentity {
  readonly acceptedSource: string;
  readonly acceptedSourceSha256: string;
  readonly derivedFixture: string;
  readonly expectedSchemaVersion: number;
  readonly fixedClock: string;
}

interface G3RunIdentity {
  readonly artifactName: "Q10K-G3-candidate.json" | "Q10K-G3-v1.json";
  readonly contractHash: string;
  readonly expectedSourceSha256: string;
  readonly fixture: G3FixtureIdentity;
  readonly official: boolean;
  readonly querySet: string;
}

const localBootstrapSecret = "q10k-g3-local-bootstrap-only";

function percentile(sortedValues: readonly number[], percentileValue: number) {
  const index = Math.max(
    0,
    Math.ceil((percentileValue / 100) * sortedValues.length) - 1,
  );
  return sortedValues[index] ?? 0;
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function gitHead(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

async function deriveFixture(sourcePath: string, destinationPath: string) {
  await copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
  const app = createApp({
    databasePath: destinationPath,
    featureFlags: q10kG3V1.featureProfile,
    logger: false,
    clock: () => new Date(q10kG3V1.fixture.fixedClock),
    migrationClock: () => new Date(q10kG3V1.fixture.fixedClock),
    maximumMigrationVersion: q10kG3V1.fixture.expectedSchemaVersion,
  });
  try {
    await app.ready();
  } finally {
    await app.close();
  }
  checkpointDatabase(destinationPath);
  return inspectG3Database(destinationPath);
}

function selectBinding(databasePath: string): G3SelectorBinding {
  const database = new Database(databasePath, {
    fileMustExist: true,
    readonly: true,
  });
  try {
    const row = database.prepare(`
      WITH RECURSIVE tag_paths(id, path) AS (
        SELECT id, name FROM tags WHERE parent_id IS NULL
        UNION ALL
        SELECT child.id, tag_paths.path || '/' || child.name
        FROM tags AS child
        JOIN tag_paths ON child.parent_id = tag_paths.id
      ), current_membership AS (
        SELECT assignments.logical_page_id, assignments.resource_id
        FROM logical_page_resource_heads AS heads
        JOIN logical_page_resource_assignments AS assignments
          ON assignments.id = heads.assignment_id
        WHERE assignments.action = 'assigned'
      )
      SELECT membership.resource_id, resources.resource_key,
        tag_paths.path AS topic_path, tabs.browser, tabs.status,
        tabs.importance, COUNT(*) AS hit_count
      FROM current_membership AS membership
      JOIN resources ON resources.id = membership.resource_id
      JOIN resource_heads ON resource_heads.resource_id = resources.id
      JOIN resource_events ON resource_events.id = resource_heads.event_id
        AND resource_events.lifecycle_state = 'active'
      JOIN tabs ON tabs.logical_page_id = membership.logical_page_id
      JOIN tab_tags ON tab_tags.tab_id = tabs.id
      JOIN tag_paths ON tag_paths.id = tab_tags.tag_id
      GROUP BY membership.resource_id, resources.resource_key,
        tag_paths.path, tabs.browser
      HAVING COUNT(*) >= @minimumHits
      ORDER BY hit_count DESC, resources.resource_key ASC,
        tag_paths.path ASC, tabs.browser ASC, membership.resource_id ASC
      LIMIT 1
    `).get({
      minimumHits: q10kG3V1.selector.minimumHits,
    }) as
      | {
          browser: string;
          hit_count: number;
          resource_id: number;
          resource_key: string;
          topic_path: string;
        }
      | undefined;
    if (row === undefined) {
      throw new Error("Q10K-G3 selector found no meaningful intersection");
    }
    return {
      browser: row.browser,
      hitCount: row.hit_count,
      resourceId: row.resource_id,
      resourceKey: row.resource_key,
      topic: row.topic_path,
    };
  } finally {
    database.close();
  }
}

function expectedOutcomes(
  databasePath: string,
  binding: G3SelectorBinding,
): G3ExpectedOutcomes {
  const database = new Database(databasePath, {
    fileMustExist: true,
    readonly: true,
  });
  const sharedCtes = `
    WITH RECURSIVE tag_paths(id, path) AS (
      SELECT id, name FROM tags WHERE parent_id IS NULL
      UNION ALL
      SELECT child.id, tag_paths.path || '/' || child.name
      FROM tags AS child JOIN tag_paths ON child.parent_id = tag_paths.id
    ), descendants(id) AS (
      SELECT id FROM tag_paths WHERE path = @topic
      UNION ALL
      SELECT child.id FROM tags AS child
      JOIN descendants ON child.parent_id = descendants.id
    ), current_membership AS (
      SELECT assignments.logical_page_id, assignments.resource_id
      FROM logical_page_resource_heads AS heads
      JOIN logical_page_resource_assignments AS assignments
        ON assignments.id = heads.assignment_id
      WHERE assignments.action = 'assigned'
    )
  `;
  const parameters = {
    browser: binding.browser,
    resourceId: binding.resourceId,
    topic: binding.topic,
  };
  try {
    const resourceRows = database.prepare(`${sharedCtes}
      SELECT resources.id,
        COALESCE((
          SELECT SUM(activity.foreground_ms)
          FROM tab_page_activity_totals AS activity
          JOIN logical_pages
            ON logical_pages.url_normalized = activity.url_normalized
          WHERE logical_pages.id IN (
            SELECT membership.logical_page_id
            FROM current_membership AS membership
            WHERE membership.resource_id = resources.id
          )
        ), 0) AS on_screen_ms
      FROM resources
      JOIN resource_heads ON resource_heads.resource_id = resources.id
      JOIN resource_events ON resource_events.id = resource_heads.event_id
      WHERE resource_events.lifecycle_state = 'active'
        AND EXISTS (
          SELECT 1 FROM current_membership AS membership
          JOIN tabs ON tabs.logical_page_id = membership.logical_page_id
          WHERE membership.resource_id = resources.id
            AND tabs.browser = @browser
            AND tabs.id IN (
              SELECT tab_tags.tab_id FROM tab_tags
              JOIN descendants ON descendants.id = tab_tags.tag_id
            )
        )
      ORDER BY on_screen_ms DESC, resources.id ASC
    `).all(parameters) as Array<{ id: number; on_screen_ms: number }>;

    const pageRows = database.prepare(`${sharedCtes}
      SELECT logical_pages.id
      FROM current_membership AS membership
      JOIN logical_pages ON logical_pages.id = membership.logical_page_id
      WHERE membership.resource_id = @resourceId
        AND EXISTS (
          SELECT 1 FROM tabs AS eligible_tabs
          WHERE eligible_tabs.logical_page_id = logical_pages.id
            AND eligible_tabs.id IN (
              SELECT tab_tags.tab_id FROM tab_tags
              JOIN descendants ON descendants.id = tab_tags.tag_id
            )
        )
      ORDER BY logical_pages.id ASC
    `).all(parameters) as Array<{ id: number }>;

    const libraryRows = database.prepare(`${sharedCtes}
      SELECT tabs.id
      FROM tabs
      WHERE tabs.id IN (
          SELECT tab_tags.tab_id FROM tab_tags
          JOIN descendants ON descendants.id = tab_tags.tag_id
        )
        AND EXISTS (
          SELECT 1 FROM current_membership AS membership
          WHERE membership.logical_page_id = tabs.logical_page_id
            AND membership.resource_id = @resourceId
        )
        AND NOT EXISTS (
          SELECT 1 FROM page_retention
          WHERE page_retention.tab_id = tabs.id
            AND page_retention.state = 'trashed'
        )
      ORDER BY tabs.id ASC
    `).all(parameters) as Array<{ id: number }>;

    const activity = database.prepare(`${sharedCtes}
      SELECT COALESCE(SUM(activity.foreground_ms), 0) AS on_screen_ms,
        COALESCE(SUM(activity.engaged_ms), 0) AS active_use_ms,
        MIN(activity.first_activity_at) AS coverage_start
      FROM tab_page_activity_totals AS activity
      JOIN logical_pages
        ON logical_pages.url_normalized = activity.url_normalized
      WHERE logical_pages.id IN (
        SELECT membership.logical_page_id
        FROM current_membership AS membership
        WHERE membership.resource_id = @resourceId
      )
    `).get(parameters) as {
      active_use_ms: number;
      coverage_start: string | null;
      on_screen_ms: number;
    };

    const sensitivity = database.prepare(`${sharedCtes}
      SELECT
        (SELECT COUNT(*) FROM resources
         JOIN resource_heads ON resource_heads.resource_id = resources.id
         JOIN resource_events ON resource_events.id = resource_heads.event_id
         WHERE resource_events.lifecycle_state = 'active'
           AND EXISTS (
             SELECT 1 FROM current_membership AS membership
             JOIN tabs ON tabs.logical_page_id = membership.logical_page_id
             WHERE membership.resource_id = resources.id
               AND tabs.id IN (
                 SELECT tab_tags.tab_id FROM tab_tags
                 JOIN descendants ON descendants.id = tab_tags.tag_id
               )
           )) AS resources_without_browser,
        (SELECT COUNT(*) FROM resources
         JOIN resource_heads ON resource_heads.resource_id = resources.id
         JOIN resource_events ON resource_events.id = resource_heads.event_id
         WHERE resource_events.lifecycle_state = 'active'
           AND EXISTS (
             SELECT 1 FROM current_membership AS membership
             JOIN tabs ON tabs.logical_page_id = membership.logical_page_id
             WHERE membership.resource_id = resources.id
               AND tabs.browser = @browser
           )) AS resources_without_topic,
        (SELECT COUNT(*) FROM current_membership
         WHERE resource_id = @resourceId) AS pages_without_topic,
        (SELECT COUNT(*) FROM tabs
         WHERE tabs.id IN (
           SELECT tab_tags.tab_id FROM tab_tags
           JOIN descendants ON descendants.id = tab_tags.tag_id
         )
           AND NOT EXISTS (
             SELECT 1 FROM page_retention
             WHERE page_retention.tab_id = tabs.id
               AND page_retention.state = 'trashed'
           )) AS library_without_resource,
        (SELECT COUNT(*) FROM tabs
         WHERE EXISTS (
           SELECT 1 FROM current_membership AS membership
           WHERE membership.logical_page_id = tabs.logical_page_id
             AND membership.resource_id = @resourceId
         )
           AND NOT EXISTS (
             SELECT 1 FROM page_retention
             WHERE page_retention.tab_id = tabs.id
               AND page_retention.state = 'trashed'
           )) AS library_without_topic
    `).get(parameters) as Record<string, number>;
    const sensitivityChecks: ReadonlyArray<readonly [string, number, number]> = [
      ["resource-list:browser", sensitivity.resources_without_browser ?? 0, resourceRows.length],
      ["resource-list:topic", sensitivity.resources_without_topic ?? 0, resourceRows.length],
      ["resource-pages:topic", sensitivity.pages_without_topic ?? 0, pageRows.length],
      ["library:resource", sensitivity.library_without_resource ?? 0, libraryRows.length],
      ["library:topic", sensitivity.library_without_topic ?? 0, libraryRows.length],
    ];
    for (const [name, withoutFilter, exact] of sensitivityChecks) {
      if (exact === 0 || withoutFilter <= exact) {
        throw new Error(
          `Q10K-G3 selector is not discriminating for ${name}: ${withoutFilter} <= ${exact}`,
        );
      }
    }

    return {
      activity: {
        activeUseMs: activity.active_use_ms,
        coverageStart: activity.coverage_start,
        onScreenMs: activity.on_screen_ms,
        resourceId: binding.resourceId,
        window: "all",
        windowEnd: q10kG3V1.fixture.fixedClock,
        windowStart: activity.coverage_start,
      },
      library: {
        ids: libraryRows.slice(0, 50).map(({ id }) => id),
        total: libraryRows.length,
      },
      pages: {
        ids: pageRows.slice(0, 50).map(({ id }) => id),
        total: pageRows.length,
      },
      resources: {
        ids: resourceRows.slice(0, 50).map(({ id }) => id),
        total: resourceRows.length,
      },
    };
  } finally {
    database.close();
  }
}

function resolveQueryPath(
  query: BoundBaselineHttpQuery,
  binding: G3SelectorBinding,
): string {
  const values: Readonly<Record<string, string>> = {
    ":browser": binding.browser,
    ":resource-id": String(binding.resourceId),
    ":topic": binding.topic,
  };
  let path = query.pathTemplate;
  for (const [placeholder, value] of Object.entries(values)) {
    path = path.replaceAll(placeholder, encodeURIComponent(value));
  }
  const unresolved = path.match(/:[a-z][a-z-]*/i);
  if (unresolved !== null) {
    throw new Error(
      `Q10K-G3 query ${query.id} has unresolved placeholder ${unresolved[0]}`,
    );
  }
  return path;
}

function assertResponse(
  query: BoundBaselineHttpQuery,
  body: unknown,
  binding: G3SelectorBinding,
  expected: G3ExpectedOutcomes,
): void {
  switch (query.assertion) {
    case "resource_list_exact_intersection_page": {
      const parsed = resourceListResponseSchema.parse(body);
      const actual = {
        ids: parsed.items.map(({ resource }) => resource.id),
        total: parsed.total,
      };
      if (!sameJson(actual, expected.resources)) {
        throw new Error(`${query.id} differs from its exact SQL oracle`);
      }
      return;
    }
    case "detail_exact_resource": {
      const parsed = resourceDetailSchema.parse(body);
      if (parsed.resource.id !== binding.resourceId) {
        throw new Error(`${query.id} returned another resource`);
      }
      return;
    }
    case "pages_exact_intersection_page": {
      const parsed = resourcePagesResponseSchema.parse(body);
      const actual = {
        ids: parsed.items.map(({ logicalPageId }) => logicalPageId),
        total: parsed.total,
      };
      if (!sameJson(actual, expected.pages)) {
        throw new Error(`${query.id} differs from its exact SQL oracle`);
      }
      return;
    }
    case "activity_exact_resource_totals": {
      const parsed = resourceActivityResponseSchema.parse(body);
      if (
        parsed.resourceId !== expected.activity.resourceId ||
        parsed.activity.window !== expected.activity.window ||
        parsed.activity.onScreenMs !== expected.activity.onScreenMs ||
        parsed.activity.activeUseMs !== expected.activity.activeUseMs ||
        parsed.activity.coverageStart !== expected.activity.coverageStart ||
        parsed.activity.windowStart !== expected.activity.windowStart ||
        parsed.activity.windowEnd !== expected.activity.windowEnd
      ) {
        throw new Error(`${query.id} differs from its exact SQL oracle`);
      }
      return;
    }
    case "library_exact_intersection_page": {
      const parsed = localTabListResponseSchema.parse(body);
      const actual = {
        ids: parsed.items.map(({ id }) => id),
        total: parsed.total,
      };
      if (!sameJson(actual, expected.library)) {
        throw new Error(`${query.id} differs from its exact SQL oracle`);
      }
    }
  }
}

async function measureQueries(
  databasePath: string,
  binding: G3SelectorBinding,
  samples: number,
): Promise<G3QueryTiming[]> {
  const expected = expectedOutcomes(databasePath, binding);
  const app = createApp({
    databasePath,
    featureFlags: q10kG3V1.featureProfile,
    logger: false,
    localDevProxySecret: localBootstrapSecret,
    clock: () => new Date(q10kG3V1.fixture.fixedClock),
    migrationClock: () => new Date(q10kG3V1.fixture.fixedClock),
    maximumMigrationVersion: q10kG3V1.fixture.expectedSchemaVersion,
  });
  try {
    await app.ready();
    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/local/session/bootstrap",
      headers: {
        "x-tabhub-dev-proxy-secret": localBootstrapSecret,
      },
    });
    if (bootstrap.statusCode !== 204) {
      throw new Error(
        `Q10K-G3 local bootstrap returned ${bootstrap.statusCode}`,
      );
    }
    const cookieHeader = bootstrap.headers["set-cookie"];
    const cookie = (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader)
      ?.split(";", 1)[0];
    if (cookie === undefined || cookie.length === 0) {
      throw new Error("Q10K-G3 local bootstrap returned no session cookie");
    }
    const timings: G3QueryTiming[] = [];
    for (const query of q10kG3V1.queries) {
      const path = resolveQueryPath(query, binding);
      const headers =
        query.audience === "local"
          ? { cookie, "sec-fetch-site": q10kG3V1.authProfile.sameSiteHeader }
          : undefined;
      const execute = async () => {
        const startedAt = performance.now();
        const response = await app.inject(
          headers === undefined
            ? { method: query.method, url: path }
            : { method: query.method, url: path, headers },
        );
        const duration = performance.now() - startedAt;
        if (response.statusCode !== 200) {
          throw new Error(
            `${query.id} returned ${response.statusCode}: ${response.body}`,
          );
        }
        assertResponse(query, response.json(), binding, expected);
        return duration;
      };
      for (let warmup = 0; warmup < q10kG3V1.warmups; warmup += 1) {
        await execute();
      }
      const durations: number[] = [];
      for (let sample = 0; sample < samples; sample += 1) {
        durations.push(await execute());
      }
      durations.sort((left, right) => left - right);
      const p95Ms = rounded(percentile(durations, 95));
      timings.push({
        id: query.id,
        maxMs: rounded(durations.at(-1) ?? 0),
        p50Ms: rounded(percentile(durations, 50)),
        p95LimitMs: q10kG3V1.p95LimitMs,
        p95Ms,
        passed: p95Ms <= q10kG3V1.p95LimitMs,
        path,
        samples,
      });
    }
    return timings;
  } finally {
    await app.close();
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function runG3BaselineWithIdentity(
  options: RunG3BaselineOptions,
  identity: G3RunIdentity,
): Promise<G3BaselineResult> {
  const samples = q10kG3V1.samples;
  const expectedSourceSha256 = identity.expectedSourceSha256.toLowerCase();
  const sourceBefore = await stat(options.sourcePath);
  const sourceSha256 = await sha256DatabaseFile(options.sourcePath);
  if (sourceSha256 !== expectedSourceSha256) {
    throw new Error(
      `Q10K-G3 source SHA-256 mismatch: expected ${expectedSourceSha256}, got ${sourceSha256}`,
    );
  }
  const sourceTopics = inspectTopicFingerprints(options.sourcePath);

  await mkdir(options.workDirectory, { recursive: true });
  if ((await readdir(options.workDirectory)).length > 0) {
    throw new Error(
      `G3 baseline work directory must be empty: ${options.workDirectory}`,
    );
  }
  const claim = await open(
    join(options.workDirectory, ".g3-baseline-claimed"),
    "wx",
  );
  try {
    await claim.writeFile(
      `${JSON.stringify({ contractHash: identity.contractHash, official: identity.official })}\n`,
    );
  } finally {
    await claim.close();
  }

  const primaryPath = join(options.workDirectory, "S10K-G3-v1.sqlite");
  const replicaPath = join(options.workDirectory, "S10K-G3-v1-replica.sqlite");
  const measurementPath = join(
    options.workDirectory,
    "S10K-G3-v1-measurement.sqlite",
  );
  const primary = await deriveFixture(options.sourcePath, primaryPath);
  const replica = await deriveFixture(options.sourcePath, replicaPath);
  const exactMatch = sameJson(primary, replica);
  if (!exactMatch) {
    throw new Error("Independent Q10K-G3 fixture derivations differ");
  }
  if (
    // G3 introduced the immutable query set at schema 20. Later gates must
    // rerun the same set on additive schema heads without rewriting its hash.
    primary.schemaVersion !== q10kG3V1.fixture.expectedSchemaVersion ||
    primary.integrityCheck.length !== 1 ||
    primary.integrityCheck[0] !== "ok" ||
    primary.foreignKeyViolationCount !== 0
  ) {
    throw new Error("Derived Q10K-G3 fixture failed schema/integrity checks");
  }
  const binding = selectBinding(primaryPath);
  await copyFile(primaryPath, measurementPath, fsConstants.COPYFILE_EXCL);
  const queries = await measureQueries(measurementPath, binding, samples);
  checkpointDatabase(measurementPath);
  const measurementDatabase = await inspectG3Database(measurementPath);
  if (
    !sameJson(primary.resourceTables, measurementDatabase.resourceTables) ||
    !sameJson(primary.topics, measurementDatabase.topics)
  ) {
    throw new Error("Q10K-G3 measurement mutated resource/topic projections");
  }

  const sourceAfter = await stat(options.sourcePath);
  const sourceAfterSha256 = await sha256DatabaseFile(options.sourcePath);
  const sourceUnchanged =
    sourceAfterSha256 === sourceSha256 &&
    sourceAfter.mtimeMs === sourceBefore.mtimeMs;
  if (!sourceUnchanged) {
    throw new Error("Accepted S10K-v1 source changed during Q10K-G3 derivation");
  }
  const topicPreservation = {
    primaryMatchesSource: sameJson(primary.topics, sourceTopics),
    replicaMatchesSource: sameJson(replica.topics, sourceTopics),
    measurementMatchesSource: sameJson(measurementDatabase.topics, sourceTopics),
  };
  if (!Object.values(topicPreservation).every(Boolean)) {
    throw new Error("Q10K-G3 changed Topic rows or checksums");
  }
  const result: G3BaselineResult = {
    contractHash: identity.contractHash,
    databaseDeterminism: { primary, replica, exactMatch },
    featureProfile: q10kG3V1.featureProfile,
    fixture: identity.fixture,
    measurementDatabase,
    official: identity.official,
    passed: identity.official && queries.every(({ passed }) => passed),
    performancePassed: queries.every(({ passed }) => passed),
    queries,
    querySet: identity.querySet,
    runtime: {
      command: process.argv,
      head: gitHead(),
      node: process.version,
      platform: process.platform,
    },
    selector: { binding, contract: q10kG3V1.selector },
    source: {
      afterSha256: sourceAfterSha256,
      beforeMtimeMs: sourceBefore.mtimeMs,
      beforeSha256: sourceSha256,
      path: options.sourcePath,
      topicFingerprints: sourceTopics,
      unchanged: sourceUnchanged,
    },
    topicPreservation,
    warmups: q10kG3V1.warmups,
  };
  const resultPath = join(options.workDirectory, identity.artifactName);
  const temporaryResultPath = `${resultPath}.tmp`;
  await writeFile(temporaryResultPath, `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
  });
  await rename(temporaryResultPath, resultPath);
  return result;
}

export async function runG3Baseline(
  options: RunG3BaselineOptions,
): Promise<G3BaselineResult> {
  return runG3BaselineWithIdentity(options, {
    artifactName: "Q10K-G3-v1.json",
    contractHash: q10kG3V1Hash,
    expectedSourceSha256: q10kG3V1.fixture.acceptedSourceSha256,
    fixture: q10kG3V1.fixture,
    official: true,
    querySet: q10kG3V1.querySet,
  });
}

/**
 * Exercises the derivation and exact-query oracle on a disposable fixture.
 * It can never emit or PASS as the accepted Q10K-G3-v1 artifact.
 */
export async function runG3CandidateBaselineForTest(
  options: RunG3BaselineOptions & { readonly expectedSourceSha256: string },
): Promise<G3BaselineResult> {
  const fixture = Object.freeze({
    ...q10kG3V1.fixture,
    acceptedSource: "noncanonical-test-candidate",
    acceptedSourceSha256: options.expectedSourceSha256.toLowerCase(),
    derivedFixture: "noncanonical-G3-test-candidate",
  });
  const querySet = "Q10K-G3-candidate";
  return runG3BaselineWithIdentity(options, {
    artifactName: "Q10K-G3-candidate.json",
    contractHash: baselineContractHash({ ...q10kG3V1, fixture, querySet }),
    expectedSourceSha256: fixture.acceptedSourceSha256,
    fixture,
    official: false,
    querySet,
  });
}
