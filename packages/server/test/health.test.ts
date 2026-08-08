import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { healthResponseSchema } from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

describe("GET /api/health", () => {
  it("reports a migrated, ready local database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-health-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/health",
      });

      expect(response.statusCode).toBe(200);
      expect(healthResponseSchema.parse(response.json())).toEqual({
        status: "ok",
        database: "ok",
        schemaVersion: 1,
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("can reopen an already migrated database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-reopen-"));
    const databasePath = join(directory, "tabhub.sqlite");

    try {
      const firstApp = createApp({ databasePath, logger: false });
      await firstApp.inject({ method: "GET", url: "/api/health" });
      await firstApp.close();

      const reopenedApp = createApp({ databasePath, logger: false });

      try {
        const response = await reopenedApp.inject({
          method: "GET",
          url: "/api/health",
        });

        expect(response.statusCode).toBe(200);
        expect(healthResponseSchema.parse(response.json()).schemaVersion).toBe(
          1,
        );
      } finally {
        await reopenedApp.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
