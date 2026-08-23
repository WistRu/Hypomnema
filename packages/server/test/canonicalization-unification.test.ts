import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CanonicalizationError,
  canonicalJsonV1,
  personalPriorityRequestFingerprint as browserPersonalPriorityRequestFingerprint,
  sqlJsonObjectMirrorV1,
  SqlJsonMirrorError,
} from "@tabhub/shared";

import {
  personalPriorityRequestFingerprint as serverPersonalPriorityRequestFingerprint,
} from "../src/personal-priority-rules.js";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));

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
  "packages/shared/src/research-contracts.ts",
  "packages/server/test/baseline-g6-acceptance.test.ts",
  "packages/server/test/baseline-g8.test.ts",
  "packages/server/test/canonicalization-unification.test.ts",
  "packages/server/test/durable-ai-jobs.test.ts",
  "packages/server/test/personal-priority-materialization-acceptance.test.ts",
  "packages/server/test/persisted-fingerprint-divergence.test.ts",
];

/** Build output and generated trees are not sources anyone maintains. */
const skippedDirectories = new Set([
  "node_modules", "dist", "coverage", ".wxt", ".output", ".vite",
]);

async function* typescriptFiles(
  directory: string,
  prefix: string,
): AsyncGenerator<{ relativePath: string; absolutePath: string }> {
  for (const entry of await readdir(join(workspaceRoot, directory), {
    withFileTypes: true,
  })) {
    const relativePath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      if (skippedDirectories.has(entry.name)) continue;
      yield* typescriptFiles(join(directory, entry.name), `${relativePath}/`);
      continue;
    }
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
    yield { relativePath, absolutePath: join(workspaceRoot, directory, entry.name) };
  }
}

/**
 * Every package, not one. The invariant is that no module anywhere disagrees with
 * another about the fingerprint of the same data, and a copy in the browser bundle
 * breaks it exactly as a copy in the server does — a request fingerprinted one way
 * and verified the other is rejected for a reason nobody can see.
 */
async function readWorkspaceSources(): Promise<ReadonlyMap<string, string>> {
  const files: { relativePath: string; absolutePath: string }[] = [];
  for (const workspacePackage of await readdir(join(workspaceRoot, "packages"))) {
    const directory = `packages/${workspacePackage}`;
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

  it("keeps every package on the shared canonicalization", async () => {
    const sources = await readWorkspaceSources();
    const offenders: string[] = [];
    for (const [relativePath, source] of sources) {
      if (independentOracles.includes(relativePath)) continue;
      if (privateCanonicalizationsIn(source).length > 0) offenders.push(relativePath);
    }
    expect(offenders.sort()).toEqual([]);
  });

  it("keeps the oracle allowlist free of entries that no longer need it", async () => {
    const sources = await readWorkspaceSources();
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

  it("agrees across the wire about a personal priority request fingerprint", async () => {
    // The browser computes this before sending and the server recomputes it before
    // accepting, so a disagreement rejects a legitimate request with no visible cause.
    const payloads: readonly unknown[] = [
      { b: 1, a: 2 },
      { rules: [{ ruleKey: "personal.x", effects: { scoreDelta: 3 } }], version: 1 },
      { nested: { d: 4, c: [3, 1, 2] } },
      { at: new Date("2026-08-23T10:11:12.130Z") },
      { "é": "стр", emoji: "\u{1f600}" },
      { zero: 0, negZero: -0, exp: 1e21 },
      [],
      {},
    ];
    for (const payload of payloads) {
      expect(
        await browserPersonalPriorityRequestFingerprint(payload),
        `fingerprint of ${canonicalJsonV1(payload)}`,
      ).toBe(serverPersonalPriorityRequestFingerprint(payload as object));
    }
  });

  it("refuses on both sides of the wire what neither can represent", async () => {
    await expect(browserPersonalPriorityRequestFingerprint({ score: Number.NaN }))
      .rejects.toThrow(CanonicalizationError);
    expect(() => serverPersonalPriorityRequestFingerprint({ score: Number.NaN }))
      .toThrow(CanonicalizationError);
    await expect(browserPersonalPriorityRequestFingerprint({ note: undefined }))
      .rejects.toThrow(CanonicalizationError);
    expect(() => serverPersonalPriorityRequestFingerprint({ note: undefined }))
      .toThrow(CanonicalizationError);
  });
});
