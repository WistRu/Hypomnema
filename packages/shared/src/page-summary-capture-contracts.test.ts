import { describe, expect, it } from "vitest";

import {
  featureFlagsResponseSchema,
  tabCommandRelayHttpResponseSchema,
} from "./index.js";

describe("page-summary capture capability contracts", () => {
  it("keeps the optional capability rolling-compatible and boolean", () => {
    expect(featureFlagsResponseSchema.parse({
      context: false,
      logicalImportance: false,
    })).not.toHaveProperty("pageSummaryCapture");

    expect(featureFlagsResponseSchema.parse({
      context: false,
      logicalImportance: false,
      pageSummaryCapture: true,
    })).toMatchObject({ pageSummaryCapture: true });

    expect(featureFlagsResponseSchema.safeParse({
      context: false,
      logicalImportance: false,
      pageSummaryCapture: "true",
    }).success).toBe(false);
  });

  it("exposes a precise typed not-sent relay rejection", () => {
    expect(tabCommandRelayHttpResponseSchema.parse({
      error: "PAGE_SUMMARY_CAPTURE_UNAVAILABLE",
      message: "Page capture is disabled.",
      ok: false,
      outcome: "not-sent",
    })).toEqual({
      error: "PAGE_SUMMARY_CAPTURE_UNAVAILABLE",
      message: "Page capture is disabled.",
      ok: false,
      outcome: "not-sent",
    });
  });
});
