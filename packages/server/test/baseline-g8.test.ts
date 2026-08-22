import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createSyntheticBaselineFixture } from "../src/baseline-database.js";
import {
  q10kG8V1,
  q10kG8V1Hash,
  runG8Baseline,
  runG8CandidateBaselineForTest,
} from "../src/baseline-g8-runner.js";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Cannot canonicalize undefined");
  return encoded;
}

function independentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function fileHash(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

describe("Q10K-G8-v1 immutable research-preflight baseline", () => {
  it("pins the complete contract, independent hash and official CLI", async () => {
    expect(q10kG8V1Hash)
      .toBe("93fc78cbec2800635fd39a95783b4dcab2c6d8855585a07ca6253de956a9c460");
    expect(independentHash(q10kG8V1)).toBe(q10kG8V1Hash);
    expectDeepFrozen(q10kG8V1);
    expect(q10kG8V1).toMatchObject({
      querySet: "Q10K-G8-v1",
      fixture: {
        acceptedSource: "S10K-v1",
        acceptedSourceSha256:
          "d5cb2f53d3ba7bca7cf764b17ad7893536df5ffe29e131a65765848a5d71eefe",
      expectedSchemaVersion: 24,
        targetSizes: [1, 100, 10_000],
        snapshotCap: 100,
        sourceCap: 100,
      },
      warmups: 3,
      samples: 20,
      statementExecutionLimit: 30,
      p95LimitMs: 2_000,
    });
    expect(q10kG8V1.authProfile.bootstrapOutsideMeasurement).toBe(true);
    expect(q10kG8V1.oracle.productionFingerprintImportsAllowed).toBe(false);

    const packageJson = JSON.parse(await readFile(
      new URL("../package.json", import.meta.url), "utf8",
    )) as { scripts?: Record<string, string> };
    const cli = await readFile(new URL("../src/baseline-g8-cli.ts", import.meta.url), "utf8");
    const runner = await readFile(
      new URL("../src/baseline-g8-runner.ts", import.meta.url), "utf8",
    );
    expect(packageJson.scripts?.["baseline:g8"]).toBe("tsx src/baseline-g8-cli.ts");
    expect(cli).toContain("runG8Baseline");
    expect(cli).not.toContain("runG8CandidateBaselineForTest");
    expect(runner).toContain("function buildOracle(");
    expect(runner).not.toContain("fingerprintResearchCorpus");
    expect(runner).not.toContain("researchCanonicalSha256PayloadV1");
  });

  it("rejects a noncanonical official source before claiming its work directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-g8-reject-"));
    const sourcePath = join(directory, "candidate.sqlite");
    const workDirectory = join(directory, "must-not-exist");
    try {
      await createSyntheticBaselineFixture(sourcePath, {
        rowCount: 10,
      });
      await expect(runG8Baseline({ sourcePath, workDirectory }))
        .rejects.toThrow("Q10K-G8 accepted source path mismatch");
      await expect(access(workDirectory)).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("derives twice and proves a write-free exact-oracle preflight at 1/100/10000", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-g8-candidate-"));
    const sourcePath = join(directory, "candidate.sqlite");
    const workDirectory = join(directory, "work");
    try {
      await createSyntheticBaselineFixture(sourcePath, {
        rowCount: 40,
      });
      const sourceSha256 = await fileHash(sourcePath);
      const sourceBefore = await stat(sourcePath);
      const run = await runG8CandidateBaselineForTest({
        sourcePath,
        expectedSourceSha256: sourceSha256,
        workDirectory,
        samples: 1,
        warmups: 1,
      });
      const result = run.result;
      expect(result.official).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.correctnessPassed).toBe(true);
      expect(result.performancePassed).toBe(true);
      expect(result.databaseDeterminism.exactBytes).toBe(true);
      expect(result.databaseDeterminism.primary).toEqual(
        result.databaseDeterminism.replica,
      );
      expect(result.databaseDeterminism.primary).toMatchObject({
        schemaVersion: 24,
        integrityCheck: ["ok"],
        foreignKeyViolationCount: 0,
      });
      expect(result.scopes.map((scope) => scope.manifestSize))
        .toEqual([1, 100, 10_000]);
      expect(result.scopes.map((scope) => scope.snapshotCount))
        .toEqual([1, 100, 100]);
      expect(result.scopes.map((scope) => scope.includedSourceCount))
        .toEqual([1, 100, 100]);
      expect(result.scopes.at(-1)?.coverage).toEqual({
        captured: 9_900,
        discovered: 10_000,
        eligible: 9_800,
        failed: 0,
        missing: 100,
        used: 0,
      });
      expect(result.scopes.every((scope) =>
        scope.maximumPreparedStatementExecutions <= 30 &&
        scope.maximumWriteStatementExecutions === 0 &&
        scope.maximumTotalChangesDelta === 0 &&
        scope.oracleMatches === 2)).toBe(true);
      expect(result.measurement).toMatchObject({
        bytesUnchanged: true,
        totalChangesDelta: 0,
      });
      expect(result.measurement.before).toEqual(result.measurement.after);
      expect(result.source.unchanged).toBe(true);
      expect(await fileHash(sourcePath)).toBe(sourceSha256);
      expect((await stat(sourcePath)).mtimeMs).toBe(sourceBefore.mtimeMs);

      expect(run.evidence).toMatchObject({
        artifactSha256: await fileHash(run.artifactPath),
        contractSha256: result.contractHash,
        primaryDerivedSha256: result.databaseDeterminism.primary.fileSha256,
        replicaDerivedSha256: result.databaseDeterminism.replica.fileSha256,
        runnerSourceSha256: result.hashes.runnerSourceSha256,
        sourceSha256,
      });
      expect(JSON.parse(await readFile(run.artifactPath, "utf8"))).toEqual(result);
      expect(JSON.parse(await readFile(run.evidencePath, "utf8"))).toEqual(run.evidence);
      expect((await readdir(workDirectory)).sort()).toEqual([
        ".g8-baseline-claimed",
        "Q10K-G8-candidate.evidence.json",
        "Q10K-G8-candidate.json",
        "S10K-G8-v1-measurement.sqlite",
        "S10K-G8-v1-replica.sqlite",
        "S10K-G8-v1.sqlite",
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 180_000);
});
