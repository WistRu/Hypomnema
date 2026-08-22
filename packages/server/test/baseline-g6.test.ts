import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  baselineContractHash,
  q10kG6V1,
  q10kG6V1Hash,
} from "../src/baseline-contract.js";
import { createSyntheticBaselineFixture } from "../src/baseline-database.js";
import {
  runG6Baseline,
  runG6CandidateBaselineForTest,
} from "../src/baseline-g6-runner.js";

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function directoryFingerprint(path: string) {
  const names = (await readdir(path)).sort();
  return Promise.all(names.map(async (name) => ({
    mtimeMs: (await stat(join(path, name))).mtimeMs,
    name,
    sha256: await sha256(join(path, name)),
    size: (await stat(join(path, name))).size,
  })));
}

describe("Q10K-G6-v1 baseline", () => {
  it("pins the complete immutable priority query and fixture contract", () => {
    expect(q10kG6V1Hash).toBe(
      "01fe14e227f50a1124eff7da275d613199992d3127942f023e495c37b7c05cb5",
    );
    expect(Object.isFrozen(q10kG6V1)).toBe(true);
    expect(Object.isFrozen(q10kG6V1.queries)).toBe(true);
    expect(q10kG6V1.queries).toHaveLength(10);
    expect(q10kG6V1.warmups).toBe(3);
    expect(q10kG6V1.samples).toBe(20);
    expect(q10kG6V1.p95LimitMs).toBe(1_000);
    expect(q10kG6V1.derivationFeatureProfile.priorityAssessmentWriter).toBe(true);
    expect(q10kG6V1.measurementFeatureProfile.priorityAssessmentWriter).toBe(false);
    expect(baselineContractHash({ ...q10kG6V1, samples: 21 }))
      .not.toBe(q10kG6V1Hash);
  });

  it("derives twice and proves exact ordering, coverage and writer-off noninterference", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-g6-baseline-"));
    const sourcePath = join(directory, "S10K-v1.sqlite");
    const workDirectory = join(directory, "work");
    try {
      await createSyntheticBaselineFixture(sourcePath, { rowCount: 1_000 });
      const sourceHash = await sha256(sourcePath);
      const sourceBefore = await stat(sourcePath);
      const result = await runG6CandidateBaselineForTest({
        expectedSourceSha256: sourceHash,
        sourcePath,
        workDirectory,
      });

      expect(result.official).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.performancePassed).toBe(true);
      expect(result.correctnessPassed).toBe(true);
      expect(result.databaseDeterminism.exactMatch).toBe(true);
      expect(result.databaseDeterminism.primary).toEqual(result.databaseDeterminism.replica);
      expect(result.databaseDeterminism.primary.schemaVersion).toBe(23);
      expect(result.queries.map(({ id }) => id)).toEqual(
        q10kG6V1.queries.map(({ id }) => id),
      );
      expect(result.queries.every(({ samples }) => samples === 20)).toBe(true);
      expect(result.fullSweep.passed).toBe(true);
      expect(result.fixtureCoverage.passed).toBe(true);
      expect(result.measurementNoninterference).toBe(true);
      expect(result.source.unchanged).toBe(true);
      expect(await sha256(sourcePath)).toBe(sourceHash);
      expect((await stat(sourcePath)).mtimeMs).toBe(sourceBefore.mtimeMs);
      expect(JSON.parse(await readFile(
        join(workDirectory, "Q10K-G6-candidate.json"), "utf8",
      ))).toEqual(result);

      const beforeRetry = await directoryFingerprint(workDirectory);
      await expect(runG6CandidateBaselineForTest({
        expectedSourceSha256: sourceHash, sourcePath, workDirectory,
      })).rejects.toThrow("G6 baseline work directory must be empty");
      expect(await directoryFingerprint(workDirectory)).toEqual(beforeRetry);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it("rejects an unaccepted official source before creating a work directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-g6-source-"));
    const sourcePath = join(directory, "source.sqlite");
    const workDirectory = join(directory, "must-not-exist");
    try {
      await createSyntheticBaselineFixture(sourcePath, { rowCount: 40 });
      await expect(runG6Baseline({ sourcePath, workDirectory }))
        .rejects.toThrow(/Q10K-G6 accepted source path mismatch|source SHA-256 mismatch/);
      await expect(access(workDirectory)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
