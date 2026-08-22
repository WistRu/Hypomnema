import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CanonicalizationError,
  canonicalJsonV1,
  sqlJsonObjectMirrorV1,
} from "@tabhub/shared";

const sourceDirectory = fileURLToPath(new URL("../src", import.meta.url));

describe("canonicalization unification", () => {
  it("keeps every server module on the shared canonicalization", async () => {
    const offenders: string[] = [];
    for (const entry of await readdir(sourceDirectory)) {
      if (!entry.endsWith(".ts")) continue;
      const source = await readFile(join(sourceDirectory, entry), "utf8");
      if (/^(?:export )?function canonicalJson\b/m.test(source)) {
        offenders.push(entry);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("separates the canonical fingerprint contract from the SQL byte mirror", () => {
    // The canonical contract sorts keys; the SQL mirror must not, because SQLite
    // triggers build the same bytes with json_object() in declaration order.
    expect(canonicalJsonV1({ tableName: "research_runs", pkV1: "i:7" }))
      .toBe('{"pkV1":"i:7","tableName":"research_runs"}');
    expect(sqlJsonObjectMirrorV1({ tableName: "research_runs", pkV1: "i:7" }))
      .toBe('{"tableName":"research_runs","pkV1":"i:7"}');
    expect(sqlJsonObjectMirrorV1({ rows: 7n })).toBe('{"rows":"7"}');
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
