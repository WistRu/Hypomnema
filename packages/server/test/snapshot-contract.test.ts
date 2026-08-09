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
  it("requires native tab IDs for modern installations while accepting queued legacy snapshots", () => {
    const tabWithoutNativeId = {
      url: "https://example.com/legacy",
      windowId: 1,
      index: 0,
    };

    expect(
      ingestSnapshotSchema.safeParse({
        browser: "chrome",
        tabs: [tabWithoutNativeId],
      }).success,
    ).toBe(true);

    const modern = ingestSnapshotSchema.safeParse({
      browser: "chrome",
      installationId: "b77ac5af-f3e0-4fa1-bcb5-f45235980222",
      tabs: [tabWithoutNativeId],
    });
    expect(modern.success).toBe(false);
    if (!modern.success) {
      expect(modern.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ["tabs", 0, "tabId"] }),
        ]),
      );
    }
  });

  it("preserves an optional browser session UUID on modern snapshots", () => {
    const browserSessionId = "04f67f70-8f3b-4a60-a2a7-2b744b34d615";
    const modernSnapshot = {
      browser: "chrome" as const,
      installationId: "8d279c3a-f258-4ce8-8cc2-82b2f444c5aa",
      tabs: [
        {
          tabId: 41,
          url: "https://example.com/session-contract",
          windowId: 1,
          index: 0,
        },
      ],
    };

    expect(ingestSnapshotSchema.safeParse(modernSnapshot).success).toBe(true);
    expect(
      ingestSnapshotSchema.parse({
        ...modernSnapshot,
        browserSessionId,
      }),
    ).toMatchObject({ browserSessionId });
  });

  it("rejects a malformed browser session ID", () => {
    const parsed = ingestSnapshotSchema.safeParse({
      browser: "chrome",
      installationId: "99b309a7-65f4-4a5f-9ccc-7a9c25039ecf",
      browserSessionId: "not-a-uuid",
      tabs: [
        {
          tabId: 42,
          url: "https://example.com/invalid-session-contract",
          windowId: 1,
          index: 0,
        },
      ],
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ["browserSessionId"] }),
        ]),
      );
    }
  });

  it.each([
    {
      browserSessionId: null,
      installationId: "99b309a7-65f4-4a5f-9ccc-7a9c25039ecf",
      label: "an explicit null session",
    },
    {
      browserSessionId: "04f67f70-8f3b-4a60-a2a7-2b744b34d615",
      installationId: undefined,
      label: "a session without an installation",
    },
  ])("rejects $label", ({ browserSessionId, installationId }) => {
    const parsed = ingestSnapshotSchema.safeParse({
      browser: "chrome",
      browserSessionId,
      ...(installationId === undefined ? {} : { installationId }),
      tabs: [
        {
          tabId: 43,
          url: "https://example.com/invalid-session-scope",
          windowId: 1,
          index: 0,
        },
      ],
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ["browserSessionId"] }),
        ]),
      );
    }
  });

  it("rejects duplicate native tab IDs in one modern snapshot atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-duplicate-native-id-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId: "0fcf4105-b9b4-452f-a623-3273bd8a1fb3",
          tabs: [
            {
              tabId: 77,
              url: "https://example.com/first",
              windowId: 1,
              index: 0,
            },
            {
              tabId: 77,
              url: "https://example.com/second",
              windowId: 1,
              index: 1,
            },
          ],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: "VALIDATION_ERROR",
        issues: [
          expect.objectContaining({ path: ["tabs", 1, "tabId"] }),
        ],
      });
      const canonical = await app.inject({ method: "GET", url: "/api/tabs" });
      const physical = await app.inject({
        method: "GET",
        url: "/api/tab-instances",
      });
      expect(canonical.json().total).toBe(0);
      expect(physical.json().total).toBe(0);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

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
