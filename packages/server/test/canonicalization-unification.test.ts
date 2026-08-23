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
 * The shapes a private canonicalization takes: object keys sorted and then re-emitted,
 * whether through `.map`/`.reduce` or a `for` loop, with or without a comparator. A
 * plain sorted key-set assertion is deliberately not one of them.
 */
const privateCanonicalizationShapes = [
  {
    name: "sorted-keys-mapped",
    pattern:
      /Object\.(?:keys|entries)\s*\([\s\S]{0,120}?\.sort\s*\([\s\S]{0,80}?\)\s*\.\s*(?:map|reduce|flatMap)\s*\(/,
  },
  {
    name: "sorted-keys-loop",
    pattern:
      /for\s*\(\s*const\s+[\s\S]{0,60}?of\s+Object\.(?:keys|entries)\s*\([\s\S]{0,120}?\.sort\s*\(/,
  },
] as const;

function privateCanonicalizationsIn(source: string): readonly string[] {
  return privateCanonicalizationShapes
    .filter((shape) => shape.pattern.test(source)).map((shape) => shape.name);
}

/**
 * Files allowed to spell the algorithm out themselves. The baseline and independent
 * acceptance tests are the oracle the production fingerprints are checked against, and
 * an oracle that imports the code under test proves nothing; the divergence test
 * reproduces the retired algorithms on purpose, to show what they used to produce.
 *
 * This file is listed too: it holds the deliberate rewrites the guard is checked
 * against, so it must trip the guard rather than pass it.
 *
 * Every entry is verified below: an entry that no longer carries its own copy fails the
 * suite, so the list cannot quietly outlive the reason it exists.
 */
const independentOracles = [
  "test/baseline-g6-acceptance.test.ts",
  "test/canonicalization-unification.test.ts",
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

async function readPackageSources(): Promise<
  ReadonlyMap<string, string>
> {
  const files: { relativePath: string; absolutePath: string }[] = [];
  for (const directory of ["src", "test"]) {
    for await (const file of typescriptFiles(directory, `${directory}/`)) {
      files.push(file);
    }
  }
  const sources = await Promise.all(
    files.map(async (file) => [
      file.relativePath,
      await readFile(file.absolutePath, "utf8"),
    ] as const),
  );
  return new Map(sources);
}

describe("canonicalization unification", () => {
  it("recognises a private canonicalization however it is written", () => {
    const rewrites = [
      'return `{${Object.keys(r).sort().map((k) => k).join(",")}}`;',
      'return Object.keys(r).sort((a, b) => (a < b ? -1 : 1)).map((k) => k).join(",");',
      'for (const key of Object.keys(record).sort()) { out += key; }',
      'for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {}',
      'return [...Object.keys(record)].sort().map((k) => k).join(",");',
      'Object.entries(r).sort().reduce((acc, [k]) => acc + k, "");',
    ];
    for (const rewrite of rewrites) {
      expect(privateCanonicalizationsIn(rewrite), rewrite).not.toEqual([]);
    }
    // A sorted key-set assertion is not a canonicalization and must stay allowed.
    expect(privateCanonicalizationsIn(
      'expect(Object.keys(first).sort()).toEqual(["a", "b"]);\nJSON.stringify(first);',
    )).toEqual([]);
  });

  it("keeps every module and test on the shared canonicalization", async () => {
    const sources = await readPackageSources();
    const offenders: string[] = [];
    for (const [relativePath, source] of sources) {
      if (independentOracles.includes(relativePath)) continue;
      if (privateCanonicalizationsIn(source).length > 0) offenders.push(relativePath);
    }
    expect(offenders.sort()).toEqual([]);
  });

  it("keeps the oracle allowlist free of entries that no longer need it", async () => {
    const sources = await readPackageSources();
    const stale = independentOracles.filter((relativePath) => {
      const source = sources.get(relativePath);
      return source === undefined || privateCanonicalizationsIn(source).length === 0;
    });
    expect(stale).toEqual([]);
  });

  it("separates the canonical fingerprint contract from the SQL byte mirror", () => {
    // The canonical contract sorts keys; the SQL mirror must not, because SQLite
    // triggers build the same bytes with json_object() in declaration order. See
    // packages/server/migrations/026_privacy_purge_intents.sql:1813.
    expect(canonicalJsonV1({ tableName: "research_runs", pkV1: "i:7" }))
      .toBe('{"pkV1":"i:7","tableName":"research_runs"}');
    expect(sqlJsonObjectMirrorV1({ tableName: "research_runs", pkV1: "i:7" }))
      .toBe('{"tableName":"research_runs","pkV1":"i:7"}');
    // Relaxing key order is the only difference. The mirror is as strict as the
    // canonical contract about values, because its bytes are persisted as digests.
    expect(() => sqlJsonObjectMirrorV1({ rows: 7n })).toThrow(SqlJsonMirrorError);
    expect(() => sqlJsonObjectMirrorV1(undefined)).toThrow(SqlJsonMirrorError);
    expect(() => sqlJsonObjectMirrorV1({ note: undefined })).toThrow(SqlJsonMirrorError);
    expect(() => sqlJsonObjectMirrorV1({ score: Number.NaN })).toThrow(SqlJsonMirrorError);
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
