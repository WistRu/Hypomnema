import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { splitActivityByUtcDate } from "../src/activity-catalog.js";

const installationId = "122e4567-e89b-42d3-a456-426614174000";
const browserSessionId = "222e4567-e89b-42d3-a456-426614174000";
const flags = {
  activityDailyWriter: true,
  activityWindows: true,
  context: false,
  logicalImportance: true,
  resources: true,
  priorityShadow: false,
  research: false,
} as const;

function event(input: Partial<{
  id: string;
  browser: "chrome" | "edge";
  sequence: number;
  url: string;
  startedAt: string;
  endedAt: string;
  foregroundMs: number;
  engagedMs: number;
}> = {}) {
  return {
    id: input.id ?? "323e4567-e89b-42d3-a456-426614174000",
    browser: input.browser ?? "chrome",
    installationId,
    browserSessionId,
    browserTabId: 7,
    sequence: input.sequence ?? 1,
    url: input.url ?? "https://www.youtube.com/watch?v=daily",
    startedAt: input.startedAt ?? "2026-08-05T23:59:57.000Z",
    endedAt: input.endedAt ?? "2026-08-06T00:00:03.000Z",
    foregroundMs: input.foregroundMs ?? 5_001,
    engagedMs: input.engagedMs ?? 3_001,
  };
}

describe("logical-page daily activity", () => {
  it("splits midnight and multi-day intervals with exact deterministic conservation", () => {
    expect(splitActivityByUtcDate(event())).toEqual([
      { activityDate: "2026-08-05", foregroundMs: 2_500, engagedMs: 1_500 },
      { activityDate: "2026-08-06", foregroundMs: 2_501, engagedMs: 1_501 },
    ]);
    const multi = splitActivityByUtcDate(event({
      startedAt: "2026-08-10T23:59:59.999Z",
      endedAt: "2026-08-12T00:00:00.002Z",
      foregroundMs: 100_001,
      engagedMs: 99_999,
    }));
    expect(multi.map(({ activityDate }) => activityDate)).toEqual([
      "2026-08-10", "2026-08-11", "2026-08-12",
    ]);
    expect(multi.reduce((sum, bucket) => sum + bucket.foregroundMs, 0)).toBe(100_001);
    expect(multi.reduce((sum, bucket) => sum + bucket.engagedMs, 0)).toBe(99_999);
    expect(multi.every((bucket) =>
      bucket.engagedMs <= bucket.foregroundMs && bucket.foregroundMs >= 0)).toBe(true);
  });

  it("keeps cursor authority atomic, metrics persistent, and calendar windows honest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-daily-activity-"));
    const databasePath = join(directory, "tabhub.sqlite");
    let currentTime = new Date("2026-08-01T00:00:00.000Z");
    const clock = () => currentTime;
    let app = createApp({ databasePath, logger: false, featureFlags: flags, clock,
      migrationClock: clock });
    currentTime = new Date("2026-08-12T12:00:00.000Z");
    try {
      const first = event();
      expect((await app.inject({ method: "POST", url: "/api/ingest/activity", payload: first })).json())
        .toEqual({ accepted: true });
      const second = event({
        id: "423e4567-e89b-42d3-a456-426614174000",
        sequence: 3,
        startedAt: "2026-08-06T12:00:00.000Z",
        endedAt: "2026-08-06T12:00:02.000Z",
        foregroundMs: 2_000,
        engagedMs: 1_000,
      });
      expect((await app.inject({ method: "POST", url: "/api/ingest/activity", payload: second })).json())
        .toEqual({ accepted: true });
      expect((await app.inject({ method: "POST", url: "/api/ingest/activity", payload: second })).json())
        .toEqual({ accepted: false });
      expect((await app.inject({ method: "POST", url: "/api/ingest/activity", payload: {
        ...second, id: "523e4567-e89b-42d3-a456-426614174000", sequence: 2,
      } })).json()).toEqual({ accepted: false });
      expect((await app.inject({ method: "POST", url: "/api/ingest/activity", payload: {
        ...second, engagedMs: 999,
      } })).statusCode).toBe(409);
      const future = await app.inject({ method: "POST", url: "/api/ingest/activity", payload: {
        ...second,
        id: "623e4567-e89b-42d3-a456-426614174000",
        sequence: 4,
        startedAt: "2026-08-12T12:59:58.000Z",
        endedAt: "2026-08-12T13:00:00.000Z",
      } });
      expect(future.statusCode).toBe(400);
      expect(future.json()).toMatchObject({ error: "ACTIVITY_EVENT_IN_FUTURE" });

      const tabs = (await app.inject({ method: "GET", url: "/api/tabs" })).json().items;
      const pageId = (await app.inject({
        method: "GET",
        url: `/api/logical-pages/by-tab/${tabs[0].id}`,
      })).json().page.id as number;
      const read = async (window: "7d" | "30d" | "all") =>
        (await app.inject({
          method: "GET",
          url: `/api/logical-pages/${pageId}/activity?window=${window}`,
        })).json().activity;
      expect(await read("7d")).toMatchObject({
        window: "7d",
        onScreenMs: 4_501,
        activeUseMs: 2_501,
        windowStart: "2026-08-06T00:00:00.000Z",
        windowEnd: "2026-08-13T00:00:00.000Z",
      });
      expect(await read("30d")).toMatchObject({
        window: "30d", onScreenMs: 7_001, activeUseMs: 4_001,
        windowStart: "2026-07-14T00:00:00.000Z",
        windowEnd: "2026-08-13T00:00:00.000Z",
      });
      expect(await read("all")).toMatchObject({
        window: "all", onScreenMs: 7_001, activeUseMs: 4_001,
        coverageStart: "2026-08-05T23:59:57.000Z",
        windowStart: "2026-08-05T23:59:57.000Z",
        windowEnd: "2026-08-12T12:00:00.000Z",
      });
      expect((await app.inject({ method: "GET", url: "/api/activity/metrics" })).json())
        .toMatchObject({
          duplicateEvents: 1,
          outOfOrderRejections: 1,
          gapEvents: 1,
          missingSequences: 1,
        });
      await app.close();
      app = createApp({ databasePath, logger: false, featureFlags: flags, clock });
      expect((await app.inject({ method: "GET", url: "/api/activity/metrics" })).json())
        .toMatchObject({ duplicateEvents: 1, outOfOrderRejections: 1, gapEvents: 1 });

      const emptySnapshot = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId,
          browserSessionId: "722e4567-e89b-42d3-a456-426614174000",
          tabs: [{
            tabId: 99,
            url: "https://empty.example/page",
            title: "Empty",
            windowId: 1,
            index: 0,
          }],
        },
      });
      expect(emptySnapshot.statusCode).toBe(200);
      const emptyPage = (await app.inject({ method: "GET", url: "/api/tabs?q=empty.example" }))
        .json().items[0];
      const emptyPageId = (await app.inject({
        method: "GET",
        url: `/api/logical-pages/by-tab/${emptyPage.id}`,
      })).json().page.id as number;
      const emptyActivity = (await app.inject({
        method: "GET",
        url: `/api/logical-pages/${emptyPageId}/activity?window=7d`,
      })).json().activity;
      expect(emptyActivity).toMatchObject({ onScreenMs: 0, activeUseMs: 0 });
      expect(emptyActivity.coverageStart).toEqual(expect.any(String));
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rolls a logical page into only its current resource without browser-copy multiplication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-resource-activity-"));
    const databasePath = join(directory, "tabhub.sqlite");
    let currentTime = new Date("2026-08-01T00:00:00.000Z");
    const app = createApp({
      databasePath,
      logger: false,
      featureFlags: flags,
      localDevProxySecret: "daily-resource-secret",
      clock: () => currentTime,
      migrationClock: () => currentTime,
    });
    currentTime = new Date("2026-08-12T12:00:00.000Z");
    try {
      for (const [browser, session, tabId] of [
        ["chrome", browserSessionId, 7],
        ["edge", "822e4567-e89b-42d3-a456-426614174000", 8],
      ] as const) {
        expect((await app.inject({ method: "POST", url: "/api/ingest/snapshot", payload: {
          browser, installationId, browserSessionId: session,
          tabs: [{ tabId, url: "https://www.youtube.com/watch?v=rollup",
            title: "Rollup", windowId: 1, index: 0 }],
        } })).statusCode).toBe(200);
      }
      expect((await app.inject({ method: "POST", url: "/api/ingest/activity", payload: event({
        url: "https://www.youtube.com/watch?v=rollup",
        startedAt: "2026-08-12T10:00:00.000Z",
        endedAt: "2026-08-12T10:00:10.000Z",
        foregroundMs: 10_000,
        engagedMs: 4_000,
      }) })).statusCode).toBe(200);
      const resources = (await app.inject({ method: "GET", url: "/api/resources" })).json().items;
      const youtube = resources.find((item: { resource: { resourceKey: string } }) =>
        item.resource.resourceKey === "platform:youtube");
      const pages = (await app.inject({ method: "GET",
        url: `/api/resources/${youtube.resource.id}/pages` })).json();
      const pageId = pages.items[0].logicalPageId;
      const pageActivity = (await app.inject({ method: "GET",
        url: `/api/logical-pages/${pageId}/activity?window=7d` })).json().activity;
      const resourceActivity = (await app.inject({ method: "GET",
        url: `/api/resources/${youtube.resource.id}/activity?window=7d` })).json().activity;
      expect(resourceActivity).toEqual(pageActivity);
      expect(resourceActivity.onScreenMs).toBe(10_000);

      const bootstrap = await app.inject({ method: "POST", url: "/api/local/session/bootstrap",
        headers: { "x-tabhub-dev-proxy-secret": "daily-resource-secret" } });
      const headers = {
        cookie: String(bootstrap.headers["set-cookie"]).split(";", 1)[0]!,
        "sec-fetch-site": "same-origin",
      };
      const created = (await app.inject({ method: "POST", url: "/api/resources/commands",
        headers, payload: { kind: "create", resourceKey: "custom:activity-target",
          name: "Activity target", resourceKind: "website", accessClass: "public",
          idempotencyKey: "create-activity-target" } })).json().result.resource;
      expect((await app.inject({ method: "POST", url: "/api/resources/commands", headers,
        payload: { kind: "apply_override", logicalPageId: pageId,
          resourceId: created.resource.id,
          expectedAssignmentId: pages.items[0].currentAssignmentId,
          idempotencyKey: "move-activity-page" } })).statusCode).toBe(200);
      const oldActivity = (await app.inject({ method: "GET",
        url: `/api/resources/${youtube.resource.id}/activity?window=7d` })).json().activity;
      const newActivity = (await app.inject({ method: "GET",
        url: `/api/resources/${created.resource.id}/activity?window=7d` })).json().activity;
      expect(oldActivity.onScreenMs).toBe(0);
      expect(newActivity).toEqual(pageActivity);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rolls legacy totals, daily buckets, and the cursor back together", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-activity-rollback-"));
    const databasePath = join(directory, "tabhub.sqlite");
    let currentTime = new Date("2026-08-01T00:00:00.000Z");
    const app = createApp({
      databasePath,
      logger: false,
      featureFlags: flags,
      clock: () => currentTime,
      migrationClock: () => currentTime,
    });
    currentTime = new Date("2026-08-12T12:00:00.000Z");
    const sabotage = new Database(databasePath);
    try {
      sabotage.exec(`
        CREATE TRIGGER fail_daily_insert
        BEFORE INSERT ON logical_page_activity_daily
        BEGIN
          SELECT RAISE(ABORT, 'forced daily failure');
        END;
      `);
      const response = await app.inject({
        method: "POST",
        url: "/api/ingest/activity",
        payload: event({
          startedAt: "2026-08-12T10:00:00.000Z",
          endedAt: "2026-08-12T10:00:01.000Z",
          foregroundMs: 1_000,
          engagedMs: 500,
        }),
      });
      expect(response.statusCode).toBe(500);
      for (const tableName of [
        "tab_activity_totals",
        "tab_page_activity_totals",
        "logical_page_activity_daily",
        "tab_activity_stream_cursors",
        "logical_pages",
        "tabs",
      ]) {
        expect(
          sabotage.prepare(`SELECT COUNT(*) FROM ${tableName}`).pluck().get(),
          tableName,
        ).toBe(0);
      }
    } finally {
      sabotage.close();
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
