import { mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import Database from "better-sqlite3";

import {
  personalAttentionFeatureFlagsOff,
  type PersonalAttentionFeatureFlags,
} from "./attention-feature-flags.js";
import {
  baselineContractHashes,
  baselineContractHash,
  g0BaselineContractVersion,
  g0BaselineSchemaVersion,
  q0LibraryV1,
  q10kBaseV1,
  s10kV1,
  type BaselineHttpQuery,
} from "./baseline-contract.js";
import {
  createSyntheticBaselineFixture,
  createVerifiedDatabaseSnapshot,
  inspectDatabaseBaseline,
  type DatabaseBaselineFingerprint,
  type VerifiedDatabaseSnapshot,
} from "./baseline-database.js";
import { createApp } from "./app.js";

export interface QueryTiming {
  readonly id: string;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly path: string;
  readonly samples: number;
}

export interface QueryBaseline {
  readonly contractHash: string;
  readonly fixture: string;
  readonly queries: readonly QueryTiming[];
  readonly querySet: string;
}

export interface G0BaselineResult {
  readonly contractVersion: number;
  readonly featureFlags: PersonalAttentionFeatureFlags;
  readonly fixture: DatabaseBaselineFingerprint;
  readonly fixtureContractHash: string;
  readonly fixtureQueryBaseline: QueryBaseline;
  readonly liveQueryBaseline: QueryBaseline;
  readonly snapshot: VerifiedDatabaseSnapshot;
}

interface RunG0BaselineOptions {
  readonly samples?: number;
  readonly sourcePath: string;
  readonly syntheticRows?: number;
  readonly workDirectory: string;
}

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

function resolveQueryPath(query: BaselineHttpQuery, minimumTabId: number): string {
  return query.pathTemplate.replace(":minimum-tab-id", String(minimumTabId));
}

export async function measureLibraryQueries(
  databasePath: string,
  fixture: string,
  querySet: string,
  contractHash: string,
  queries: readonly BaselineHttpQuery[],
  samples = 20,
): Promise<QueryBaseline> {
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 1_000) {
    throw new Error("samples must be an integer between 1 and 1000");
  }

  const reader = new Database(databasePath, {
    fileMustExist: true,
    readonly: true,
  });
  const minimumTabId =
    (
      reader.prepare("SELECT MIN(id) AS id FROM tabs").get() as {
        id: number | null;
      }
    ).id ?? 0;
  reader.close();
  if (minimumTabId === 0) {
    throw new Error(`Cannot measure ${fixture}: the fixture has no tabs`);
  }

  const app = createApp({
    databasePath,
    logger: false,
    maximumMigrationVersion: g0BaselineSchemaVersion,
  });
  try {
    await app.ready();
    const timings: QueryTiming[] = [];

    for (const query of queries) {
      const path = resolveQueryPath(query, minimumTabId);
      for (let warmup = 0; warmup < 3; warmup += 1) {
        const response = await app.inject({ method: query.method, url: path });
        if (response.statusCode !== 200) {
          throw new Error(
            `${fixture}/${query.id} warmup returned ${response.statusCode}: ${response.body}`,
          );
        }
      }

      const durations: number[] = [];
      for (let sample = 0; sample < samples; sample += 1) {
        const startedAt = performance.now();
        const response = await app.inject({ method: query.method, url: path });
        durations.push(performance.now() - startedAt);
        if (response.statusCode !== 200) {
          throw new Error(
            `${fixture}/${query.id} returned ${response.statusCode}: ${response.body}`,
          );
        }
      }
      durations.sort((left, right) => left - right);
      timings.push({
        id: query.id,
        p50Ms: rounded(percentile(durations, 50)),
        p95Ms: rounded(percentile(durations, 95)),
        path,
        samples,
      });
    }

    return {
      contractHash,
      fixture,
      queries: timings,
      querySet,
    };
  } finally {
    await app.close();
  }
}

export async function runG0Baseline(
  options: RunG0BaselineOptions,
): Promise<G0BaselineResult> {
  await mkdir(options.workDirectory, { recursive: true });
  const existingEntries = await readdir(options.workDirectory);
  if (existingEntries.length > 0) {
    throw new Error(
      `G0 baseline work directory must be empty: ${options.workDirectory}`,
    );
  }
  const claim = await open(
    join(options.workDirectory, ".g0-baseline-claimed"),
    "wx",
  );
  try {
    await claim.writeFile(
      `${JSON.stringify({ contractVersion: g0BaselineContractVersion })}\n`,
    );
  } finally {
    await claim.close();
  }
  const backupPath = join(options.workDirectory, "L0-live-scale.sqlite");
  const restoredPath = join(options.workDirectory, "L0-restored.sqlite");
  const fixturePath = join(options.workDirectory, "S10K-v1.sqlite");
  const samples = options.samples ?? 20;
  const snapshot = await createVerifiedDatabaseSnapshot(
    options.sourcePath,
    backupPath,
    restoredPath,
  );
  const liveQueryBaseline = await measureLibraryQueries(
    restoredPath,
    "L0-live-scale",
    "Q0-library-v1",
    baselineContractHashes.q0LibraryV1,
    q0LibraryV1,
    samples,
  );
  const fixtureContract = Object.freeze({
    ...s10kV1,
    rowCount: options.syntheticRows ?? s10kV1.rowCount,
  });
  await createSyntheticBaselineFixture(fixturePath, {
    contract: fixtureContract,
  });
  const fixtureQueryBaseline = await measureLibraryQueries(
    fixturePath,
    fixtureContract.rowCount === s10kV1.rowCount
      ? "S10K-v1"
      : `S${fixtureContract.rowCount}`,
    "Q10K-base-v1",
    baselineContractHashes.q10kBaseV1,
    q10kBaseV1,
    samples,
  );
  // Opening the fixture through the application can checkpoint SQLite WAL
  // state and therefore change physical file bytes without changing rows.
  // Fingerprint only after the benchmark so the returned file hash describes
  // the retained artifact.
  const fixture = await inspectDatabaseBaseline(fixturePath);

  return {
    contractVersion: g0BaselineContractVersion,
    featureFlags: personalAttentionFeatureFlagsOff,
    fixture,
    fixtureContractHash: baselineContractHash(fixtureContract),
    fixtureQueryBaseline,
    liveQueryBaseline,
    snapshot,
  };
}
