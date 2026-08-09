import { describe, expect, it } from "vitest";

import { clampPage, isTrulyEmptyPage } from "../src/pagination";

describe("live collection pagination", () => {
  it("moves an out-of-range page to the last remaining page after totals shrink", () => {
    expect(clampPage(7, 60, 50)).toBe(2);
    expect(clampPage(2, 0, 50)).toBe(1);
  });

  it("does not describe an out-of-range page as empty while rows still exist elsewhere", () => {
    expect(isTrulyEmptyPage({ items: [], total: 60 })).toBe(false);
    expect(isTrulyEmptyPage({ items: [], total: 0 })).toBe(true);
  });
});
