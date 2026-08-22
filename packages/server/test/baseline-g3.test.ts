import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  baselineContractHash,
  q10kG3V1,
  q10kG3V1Hash,
} from "../src/baseline-contract.js";
import { createSyntheticBaselineFixture } from "../src/baseline-database.js";
import {
  runG3Baseline,
  runG3CandidateBaselineForTest,
} from "../src/baseline-g3-runner.js";

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function directoryFingerprint(path: string) {
  const names = (await readdir(path)).sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      sha256: await sha256(join(path, name)),
      size: (await stat(join(path, name))).size,
    })),
  );
}

describe("Q10K-G3-v1 baseline", () => {
  it("pins the complete immutable contract behind one stable hash", () => {
    expect(q10kG3V1Hash).toBe(
      "5e2199c00bbe711a213d8f1b95c75677d4545352ca09a8fb5dc6f45b8aa10b68",
    );
    expect(Object.isFrozen(q10kG3V1)).toBe(true);
    expect(Object.isFrozen(q10kG3V1.queries)).toBe(true);
    expect(Object.isFrozen(q10kG3V1.selector.ordering)).toBe(true);
    expect(q10kG3V1.queries).toHaveLength(5);
    expect(q10kG3V1.featureProfile).toEqual({
      context: true,
      logicalImportance: true,
      priorityShadow: false,
      research: false,
      resources: true,
    });
    expect(
      baselineContractHash({ ...q10kG3V1, warmups: q10kG3V1.warmups + 1 }),
    ).not.toBe(q10kG3V1Hash);
  });

  it("derives resources twice, preserves Topics, and measures all intersections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-g3-baseline-"));
    const sourcePath = join(directory, "S10K-v1.sqlite");
    const workDirectory = join(directory, "work");

    try {
      await createSyntheticBaselineFixture(sourcePath, { rowCount: 1_000 });
      const sourceHash = await sha256(sourcePath);
      const sourceBefore = await stat(sourcePath);
      const result = await runG3CandidateBaselineForTest({
        expectedSourceSha256: sourceHash,
        sourcePath,
        workDirectory,
      });

      expect(result.contractHash).not.toBe(q10kG3V1Hash);
      expect(result.fixture.acceptedSource).toBe("noncanonical-test-candidate");
      expect(result.fixture.acceptedSourceSha256).toBe(sourceHash);
      expect(result.official).toBe(false);
      expect(result.performancePassed).toBe(true);
      expect(result.passed).toBe(false);
      expect(result.databaseDeterminism.exactMatch).toBe(true);
      expect(result.databaseDeterminism.primary).toEqual(
        result.databaseDeterminism.replica,
      );
      expect(result.databaseDeterminism.primary.schemaVersion).toBe(20);
      expect(result.databaseDeterminism.primary.foreignKeyViolationCount).toBe(0);
      expect(result.databaseDeterminism.primary.integrityCheck).toEqual(["ok"]);
      expect(result.selector.binding.hitCount).toBeGreaterThan(0);
      expect(result.queries.map(({ id }) => id)).toEqual(
        q10kG3V1.queries.map(({ id }) => id),
      );
      expect(
        result.queries.every(({ samples }) => samples === q10kG3V1.samples),
      ).toBe(true);
      expect(result.topicPreservation).toEqual({
        measurementMatchesSource: true,
        primaryMatchesSource: true,
        replicaMatchesSource: true,
      });
      expect(result.source.unchanged).toBe(true);
      expect(await sha256(sourcePath)).toBe(sourceHash);
      expect((await stat(sourcePath)).mtimeMs).toBe(sourceBefore.mtimeMs);
      expect(
        JSON.parse(
          await readFile(
            join(workDirectory, "Q10K-G3-candidate.json"),
            "utf8",
          ),
        ),
      ).toEqual(result);

      const retainedBeforeRetry = await directoryFingerprint(workDirectory);
      await expect(
        runG3CandidateBaselineForTest({
          expectedSourceSha256: sourceHash,
          sourcePath,
          workDirectory,
        }),
      ).rejects.toThrow("G3 baseline work directory must be empty");
      expect(await directoryFingerprint(workDirectory)).toEqual(
        retainedBeforeRetry,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects the wrong accepted-source hash before creating artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-g3-source-"));
    const sourcePath = join(directory, "source.sqlite");
    const workDirectory = join(directory, "must-not-exist");

    try {
      await createSyntheticBaselineFixture(sourcePath, { rowCount: 40 });
      await expect(
        runG3Baseline({
          sourcePath,
          workDirectory,
        }),
      ).rejects.toThrow("Q10K-G3 source SHA-256 mismatch");
      await expect(access(workDirectory)).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
