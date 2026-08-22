import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/database.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/database.js")>();
  return {
    ...actual,
    openDatabase(...args: Parameters<typeof actual.openDatabase>) {
      const opened = actual.openDatabase(...args);
      return {
        connection: opened.connection,
        schemaVersion: 23,
        close: () => opened.close(),
      };
    },
  };
});

import { createApp } from "../src/app.js";
import { personalAttentionFeatureFlagsOff } from "../src/attention-feature-flags.js";

describe("schema-23 createApp research route boundary", () => {
  it("does not register schema-24 research routes even when the flag is requested", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-research-schema23-app-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const secret = "research-schema23-secret";
    const app = createApp({
      databasePath,
      featureFlags: {
        ...personalAttentionFeatureFlagsOff,
        context: true,
        research: true,
      },
      localDevProxySecret: secret,
      logger: false,
      clock: () => new Date("2026-08-14T12:00:00.000Z"),
      migrationClock: () => new Date("2026-08-14T12:00:00.000Z"),
    });

    try {
      const health = await app.inject({ method: "GET", url: "/api/health" });
      expect(health.json()).toMatchObject({ schemaVersion: 23 });
      const features = await app.inject({ method: "GET", url: "/api/features" });
      expect(features.json()).toMatchObject({ research: false });

      const bootstrap = await app.inject({
        method: "POST",
        url: "/api/local/session/bootstrap",
        headers: { "x-tabhub-dev-proxy-secret": secret },
      });
      expect(bootstrap.statusCode).toBe(204);
      const cookie = String(bootstrap.headers["set-cookie"]).split(";", 1)[0]!;
      const headers = { cookie, "sec-fetch-site": "same-origin" };

      for (const request of [
        { method: "GET" as const, url: "/api/research/reports?targetType=page&targetId=1" },
        { method: "GET" as const, url: "/api/research/reports/1" },
        { method: "POST" as const, url: "/api/research/preflight", payload: {} },
        { method: "GET" as const,
          url: "/api/agent/research/reports?targetType=page&targetId=1" },
        { method: "GET" as const, url: "/api/agent/research/reports/1" },
        { method: "POST" as const, url: "/api/agent/research/preflight", payload: {} },
        { method: "POST" as const, url: "/api/agent/research/runs", payload: {} },
        { method: "POST" as const,
          url: "/api/agent/ai/jobs/resource_research:1/cancel", payload: {} },
      ]) {
        const response = await app.inject({ ...request, headers });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ error: "Not Found" });
      }
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
