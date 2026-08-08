import {
  ingestSnapshotBodyLimitBytes,
  ingestSnapshotSchema,
  tabHubHttpBodyLimitBytes,
} from "@tabhub/shared";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

function largeSnapshot(tabCount: number) {
  return {
    browser: "chrome",
    tabs: Array.from({ length: tabCount }, (_, index) => ({
      url: `https://example.com/${index}`,
      title: "x".repeat(2_048),
      windowId: 1,
      index,
    })),
  };
}

describe("snapshot transport contract", () => {
  it("accepts valid snapshot JSON immediately below the schema cap", () => {
    const withinLimit = largeSnapshot(7_400);
    const byteLength = new TextEncoder().encode(
      JSON.stringify(withinLimit),
    ).byteLength;

    expect(byteLength).toBeLessThan(ingestSnapshotBodyLimitBytes);
    expect(ingestSnapshotSchema.safeParse(withinLimit).success).toBe(true);
  });

  it(
    "returns schema validation before the Fastify body boundary",
    async () => {
      const oversized = largeSnapshot(7_500);
      const byteLength = new TextEncoder().encode(
        JSON.stringify(oversized),
      ).byteLength;

      expect(byteLength).toBeGreaterThan(ingestSnapshotBodyLimitBytes);
      expect(byteLength).toBeLessThan(tabHubHttpBodyLimitBytes);
      const parsed = ingestSnapshotSchema.safeParse(oversized);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              message: expect.stringContaining("Snapshot JSON"),
            }),
          ]),
        );
      }

      const directory = await mkdtemp(join(tmpdir(), "tabhub-snapshot-cap-"));
      const app = createApp({
        databasePath: join(directory, "tabhub.sqlite"),
        logger: false,
      });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: oversized,
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: "VALIDATION_ERROR" });
      } finally {
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
