import { describe, expect, it } from "vitest";

import { shouldRefreshLibrary } from "../src/workspace-view";

describe("workspace view freshness", () => {
  it("refreshes canonical tabs when Library becomes visible", () => {
    expect(shouldRefreshLibrary("open", "library")).toBe(true);
    expect(shouldRefreshLibrary("graph", "library")).toBe(true);
    expect(shouldRefreshLibrary("library", "library")).toBe(false);
    expect(shouldRefreshLibrary("library", "open")).toBe(false);
  });
});
