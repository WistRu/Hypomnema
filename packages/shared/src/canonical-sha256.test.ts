import { describe, expect, it } from "vitest";

import {
  CanonicalizationError,
  researchCanonicalSha256PayloadV1,
} from "./index.js";

const canonical = (value: unknown): string =>
  new TextDecoder().decode(researchCanonicalSha256PayloadV1(value));

describe("researchCanonicalSha256PayloadV1", () => {
  it("pins the exact bytes for the inputs where the legacy copies diverged", () => {
    expect(canonical({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonical({ b: 1, a: { d: 4, c: [3, 1, 2] } }))
      .toBe('{"a":{"c":[3,1,2],"d":4},"b":1}');
    expect(canonical([{ b: 1, a: 2 }, [1, [2, 3]]]))
      .toBe('[{"a":2,"b":1},[1,[2,3]]]');
    expect(canonical(new Date("2026-08-23T10:11:12.130Z")))
      .toBe('"2026-08-23T10:11:12.130Z"');
    expect(canonical({ at: new Date("2026-08-23T10:11:12.130Z") }))
      .toBe('{"at":"2026-08-23T10:11:12.130Z"}');
    expect(canonical({ "é": "стр", emoji: "\u{1f600}" }))
      .toBe('{"emoji":"\u{1f600}","é":"стр"}');
    expect(canonical({ zero: 0, negZero: -0, int: 42, float: 1.5, exp: 1e21 }))
      .toBe('{"exp":1e+21,"float":1.5,"int":42,"negZero":0,"zero":0}');
    expect(canonical(null)).toBe("null");
    expect(canonical([])).toBe("[]");
    expect(canonical({})).toBe("{}");
    expect(canonical(true)).toBe("true");
    expect(canonical("plain")).toBe('"plain"');
  });

  it("rejects undefined, non-finite numbers and bigint loudly", () => {
    expect(() => researchCanonicalSha256PayloadV1(undefined))
      .toThrow(CanonicalizationError);
    expect(() => researchCanonicalSha256PayloadV1({ a: undefined }))
      .toThrow(CanonicalizationError);
    expect(() => researchCanonicalSha256PayloadV1([undefined]))
      .toThrow(CanonicalizationError);
    expect(() => researchCanonicalSha256PayloadV1({ a: { b: [1, undefined] } }))
      .toThrow(CanonicalizationError);
    expect(() => researchCanonicalSha256PayloadV1(Number.NaN))
      .toThrow(CanonicalizationError);
    expect(() => researchCanonicalSha256PayloadV1({ a: Number.POSITIVE_INFINITY }))
      .toThrow(CanonicalizationError);
    expect(() => researchCanonicalSha256PayloadV1([Number.NEGATIVE_INFINITY]))
      .toThrow(CanonicalizationError);
    expect(() => researchCanonicalSha256PayloadV1({ a: 1n }))
      .toThrow(CanonicalizationError);
    expect(() => researchCanonicalSha256PayloadV1(() => 1))
      .toThrow(CanonicalizationError);
    expect(() => researchCanonicalSha256PayloadV1({ a: Symbol("s") }))
      .toThrow(CanonicalizationError);
  });

  it("names the offending path in the error message", () => {
    expect(() => researchCanonicalSha256PayloadV1({ a: { b: [1, Number.NaN] } }))
      .toThrow(/\$\.a\.b\[1\]/);
    expect(() => researchCanonicalSha256PayloadV1({ a: 1n }))
      .toThrow(/bigint/i);
  });
});
