import { describe, expect, it } from "vitest";

import {
  activityIngestMetricsResponseSchema,
  activityRollupSchema,
  activityWindowQuerySchema,
  featureFlagsResponseSchema,
  ingestActivitySchema,
  logicalPageActivityResponseSchema,
  resourceActivityQuerySchema,
} from "./index.js";

describe("daily activity contracts", () => {
  it("accepts a 120-second interval and rejects anything longer", () => {
    const exactBoundary = {
      id: "123e4567-e89b-42d3-a456-426614174000",
      browser: "chrome",
      installationId: "223e4567-e89b-42d3-a456-426614174000",
      browserSessionId: "323e4567-e89b-42d3-a456-426614174000",
      browserTabId: 7,
      sequence: 1,
      url: "https://example.com/activity-boundary",
      startedAt: "2026-08-12T10:00:00.000Z",
      endedAt: "2026-08-12T10:02:00.000Z",
      foregroundMs: 120_000,
      engagedMs: 60_000,
    };
    expect(ingestActivitySchema.safeParse(exactBoundary).success).toBe(true);
    expect(ingestActivitySchema.safeParse({
      ...exactBoundary,
      endedAt: "2026-08-12T10:02:00.001Z",
    }).success).toBe(false);
  });

  it("defines explicit calendar windows and coverage independently", () => {
    expect(activityWindowQuerySchema.parse({})).toEqual({ window: "all" });
    expect(resourceActivityQuerySchema.parse({ window: "7d" })).toEqual({
      window: "7d",
    });
    expect(logicalPageActivityResponseSchema.parse({
      logicalPageId: 7,
      activity: {
        window: "7d",
        onScreenMs: 4_000,
        activeUseMs: 2_000,
        coverageStart: "2026-08-01T12:00:00.000Z",
        windowStart: "2026-08-06T00:00:00.000Z",
        windowEnd: "2026-08-13T00:00:00.000Z",
      },
    }).activity).toMatchObject({ window: "7d", windowStart: "2026-08-06T00:00:00.000Z" });
    expect(() => activityRollupSchema.parse({
      window: "7d",
      onScreenMs: 1,
      activeUseMs: 2,
      coverageStart: null,
      windowStart: null,
      windowEnd: "2026-08-13T00:00:00.000Z",
    })).toThrow();
  });

  it("types restart-persistent ingest counters without event payloads", () => {
    expect(activityIngestMetricsResponseSchema.parse({
      duplicateEvents: 2,
      outOfOrderRejections: 1,
      gapEvents: 1,
      missingSequences: 3,
      updatedAt: "2026-08-12T12:00:00.000Z",
    })).toEqual(expect.objectContaining({ gapEvents: 1, missingSequences: 3 }));
  });

  it("keeps activity-window capability additive for older feature responses", () => {
    expect(featureFlagsResponseSchema.parse({
      context: false,
      logicalImportance: false,
      resources: true,
    })).not.toHaveProperty("activityWindows");
    expect(featureFlagsResponseSchema.parse({
      context: false,
      logicalImportance: false,
      resources: true,
      activityWindows: true,
    })).toMatchObject({ resources: true, activityWindows: true });
  });
});
