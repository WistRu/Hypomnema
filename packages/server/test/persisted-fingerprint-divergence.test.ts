import { describe, expect, it } from "vitest";

import { CanonicalizationError, canonicalJsonV1 } from "@tabhub/shared";

/**
 * The exact algorithms the server used to carry, reproduced so the tests can show what
 * each persisted fingerprint would have been before the unification. Every payload
 * below has the shape the matching module actually hashes.
 */
function legacySilentCanonicalJson(value: unknown): string {
  // baseline-contract, priority-rule-compiler, resource-command-catalog: no guard at
  // all, so `undefined` leaked out as the JS value and non-finite numbers became null.
  if (Array.isArray(value)) {
    return `[${value.map(legacySilentCanonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${legacySilentCanonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) as unknown as string;
}

function legacyGuardedCanonicalJson(value: unknown): string {
  // ai-job-ledger and priority-assessment-coordinator: guarded against undefined, but
  // still treated every object as a bag of own keys, so a Date collapsed to {}.
  if (Array.isArray(value)) {
    return `[${value.map(legacyGuardedCanonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${legacyGuardedCanonicalJson(record[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Cannot canonicalize undefined");
  return encoded;
}

describe("persisted fingerprints under the unified canonicalization", () => {
  it("no longer stores a resource command fingerprint over invalid JSON", () => {
    // resource-command-catalog hashes the command minus its idempotency key. A rest
    // spread keeps an explicitly-undefined optional field as an own key.
    const payload = {
      kind: "set_user_evaluation",
      resourceId: 7,
      expectedVersion: 3,
      evaluation: null,
      note: undefined,
    };
    expect(legacySilentCanonicalJson(payload))
      .toBe('{"evaluation":null,"expectedVersion":3,"kind":"set_user_evaluation"'
        + ',"note":undefined,"resourceId":7}');
    expect(() => canonicalJsonV1(payload)).toThrow(CanonicalizationError);
  });

  it("no longer stores a priority assessment fingerprint over a silent null", () => {
    // priority-assessment-coordinator hashes { subject, ruleset }.
    const payload = {
      subject: { type: "page", logicalPageId: 1 },
      ruleset: { version: 2, weight: Number.POSITIVE_INFINITY },
    };
    expect(legacySilentCanonicalJson(payload)).toContain('"weight":null');
    expect(() => canonicalJsonV1(payload)).toThrow(CanonicalizationError);
  });

  it("no longer flattens a timestamp in an AI job checkpoint to an empty object", () => {
    // ai-job-ledger persists checkpoint_json and re-verifies it by recomputing.
    const checkpoint = { cursor: 5, updatedAt: new Date("2026-08-23T10:11:12.130Z") };
    expect(legacyGuardedCanonicalJson(checkpoint))
      .toBe('{"cursor":5,"updatedAt":{}}');
    expect(canonicalJsonV1(checkpoint))
      .toBe('{"cursor":5,"updatedAt":"2026-08-23T10:11:12.130Z"}');
  });

  it("keeps agreeing with the legacy bytes for every payload that was already valid", () => {
    // The unification must not move any fingerprint of well-formed data, which is why
    // no stored fingerprint had to be rewritten.
    for (const payload of [
      { kind: "merge", sourceResourceId: 1, targetResourceId: 2 },
      { subject: { type: "resource", resourceId: 9 }, ruleset: { version: 2 } },
      { columns: ["id", "name"], rows: [[1, "a"], [2, null]] },
      { cursor: 5, updatedAt: "2026-08-23T10:11:12.130Z" },
      [1, "two", true, null, { b: 1, a: 2 }],
    ]) {
      expect(canonicalJsonV1(payload)).toBe(legacyGuardedCanonicalJson(payload));
      expect(canonicalJsonV1(payload)).toBe(legacySilentCanonicalJson(payload));
    }
  });
});
