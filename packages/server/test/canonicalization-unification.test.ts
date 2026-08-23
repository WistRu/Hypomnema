import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CanonicalizationError,
  canonicalJsonV1,
  sqlJsonObjectMirrorV1,
  SqlJsonMirrorError,
} from "@tabhub/shared";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Files allowed to spell the algorithm out themselves. The baseline and independent
 * acceptance tests are the oracle the production fingerprints are checked against, and
 * an oracle that imports the code under test proves nothing; the divergence test
 * reproduces the retired algorithms on purpose, to show what they used to produce.
 */
const independentOracles = [
  "test/baseline-g6-acceptance.test.ts",
  "test/baseline-g8.test.ts",
  "test/durable-ai-jobs.test.ts",
  "test/personal-priority-materialization-acceptance.test.ts",
  "test/persisted-fingerprint-divergence.test.ts",
];

async function* typescriptFiles(
  directory: string,
  prefix: string,
): AsyncGenerator<{ relativePath: string; absolutePath: string }> {
  for (const entry of await readdir(join(packageRoot, directory), {
    withFileTypes: true,
  })) {
    const relativePath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      yield* typescriptFiles(join(directory, entry.name), `${relativePath}/`);
      continue;
    }
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
    yield { relativePath, absolutePath: join(packageRoot, directory, entry.name) };
  }
}

describe("canonicalization unification", () => {
  it("keeps every module and test on the shared canonicalization", async () => {
    const offenders: string[] = [];
    for (const directory of ["src", "test"]) {
      for await (const file of typescriptFiles(directory, `${directory}/`)) {
        if (independentOracles.includes(file.relativePath)) continue;
        const source = await readFile(file.absolutePath, "utf8");
        // The copied shape itself: recursively sorting object keys and re-emitting
        // JSON. A copy under a new name is exactly the drift this test exists for.
        if (/Object\.keys\([^)]*\)\s*\.sort\(\)\s*\.map\(/.test(source)) {
          offenders.push(file.relativePath);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("separates the canonical fingerprint contract from the SQL byte mirror", () => {
    // The canonical contract sorts keys; the SQL mirror must not, because SQLite
    // triggers build the same bytes with json_object() in declaration order. See
    // packages/server/migrations/026_privacy_purge_intents.sql:1813.
    expect(canonicalJsonV1({ tableName: "research_runs", pkV1: "i:7" }))
      .toBe('{"pkV1":"i:7","tableName":"research_runs"}');
    expect(sqlJsonObjectMirrorV1({ tableName: "research_runs", pkV1: "i:7" }))
      .toBe('{"tableName":"research_runs","pkV1":"i:7"}');
    expect(sqlJsonObjectMirrorV1({ rows: 7n })).toBe('{"rows":"7"}');
    expect(() => sqlJsonObjectMirrorV1(undefined)).toThrow(SqlJsonMirrorError);
  });

  it("fails loudly on the inputs the legacy copies silently accepted", () => {
    // baseline-contract, priority-rule-compiler and resource-command-catalog used to
    // return the JS value `undefined` here, so the digest was of the string "undefined".
    expect(() => canonicalJsonV1({ note: undefined })).toThrow(CanonicalizationError);
    // Only the priority engine and the AI job ledger rejected non-finite numbers; the
    // other copies hashed them as `null`.
    expect(() => canonicalJsonV1({ score: Number.NaN })).toThrow(CanonicalizationError);
    // Every copy flattened a Date to `{}` except the two that used a plain-object test.
    expect(canonicalJsonV1({ at: new Date("2026-08-23T00:00:00.000Z") }))
      .toBe('{"at":"2026-08-23T00:00:00.000Z"}');
  });
});
