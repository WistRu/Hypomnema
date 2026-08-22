import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

const installationId = "122e4567-e89b-42d3-a456-426614174000";
const sessionId = "222e4567-e89b-42d3-a456-426614174000";
const url = "https://www.youtube.com/watch?v=feature-gates";

function activity(sequence: number, id: string) {
  return {
    id,
    browser: "chrome",
    installationId,
    browserSessionId: sessionId,
    browserTabId: 7,
    sequence,
    url,
    startedAt: "2026-08-12T12:00:00.000Z",
    endedAt: "2026-08-12T12:00:01.000Z",
    foregroundMs: 1_000,
    engagedMs: 500,
  };
}

const baseFlags = {
  context: false,
  logicalImportance: true,
  resources: true,
  priorityShadow: false,
  research: false,
} as const;

async function fixture(flags: {
  activityDailyWriter?: boolean;
  activityWindows?: boolean;
}) {
  const directory = await mkdtemp(join(tmpdir(), "tabhub-activity-flags-"));
  const databasePath = join(directory, "tabhub.sqlite");
  let currentTime = new Date("2026-08-12T12:00:00.000Z");
  const app = createApp({
    databasePath,
    logger: false,
    featureFlags: { ...baseFlags, ...flags },
    clock: () => currentTime,
    migrationClock: () => currentTime,
  });
  currentTime = new Date("2026-08-12T12:01:00.000Z");
  expect((await app.inject({
    method: "POST",
    url: "/api/ingest/snapshot",
    payload: {
      browser: "chrome",
      installationId,
      browserSessionId: sessionId,
      tabs: [{ tabId: 7, url, title: "Feature gates", windowId: 1, index: 0 }],
    },
  })).statusCode).toBe(200);
  const resources = (await app.inject({ method: "GET", url: "/api/resources" })).json().items;
  const resource = resources.find((item: { resource: { resourceKey: string } }) =>
    item.resource.resourceKey === "platform:youtube");
  const pages = (await app.inject({
    method: "GET",
    url: `/api/resources/${resource.resource.id}/pages`,
  })).json().items;
  return { app, databasePath, directory, pageId: pages[0].logicalPageId,
    resourceId: resource.resource.id as number };
}

async function close(value: Awaited<ReturnType<typeof fixture>>) {
  await value.app.close();
  await rm(value.directory, { recursive: true, force: true });
}

describe("daily activity reader and writer feature gates", () => {
  it("fails the reader capability closed when Resources are disabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-activity-no-resources-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      featureFlags: {
        ...baseFlags,
        resources: false,
        activityWindows: true,
      },
    });
    try {
      expect((await app.inject({ method: "GET", url: "/api/features" })).json())
        .toMatchObject({ resources: false, activityWindows: false });
      expect((await app.inject({ method: "GET", url: "/api/activity/metrics" })).statusCode)
        .toBe(404);
      expect((await app.inject({ method: "GET",
        url: "/api/logical-pages/1/activity?window=7d" })).statusCode).toBe(404);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts exactly 120 seconds and rejects longer or future events with zero DB delta", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-activity-boundary-"));
    const databasePath = join(directory, "tabhub.sqlite");
    let now = new Date("2026-08-12T12:00:00.000Z");
    const app = createApp({
      databasePath,
      logger: false,
      featureFlags: {
        ...baseFlags,
        activityDailyWriter: true,
        activityWindows: true,
      },
      clock: () => now,
      migrationClock: () => new Date("2026-08-12T10:00:00.000Z"),
    });
    const exact = {
      ...activity(2, "823e4567-e89b-42d3-a456-426614174000"),
      startedAt: "2026-08-12T10:00:00.000Z",
      endedAt: "2026-08-12T10:02:00.000Z",
      foregroundMs: 120_000,
      engagedMs: 60_000,
    };
    try {
      expect((await app.inject({ method: "POST", url: "/api/ingest/activity", payload: exact }))
        .json()).toEqual({ accepted: true });
      const inspect = () => {
        const database = new Database(databasePath, { readonly: true });
        try {
          return {
            cursors: database.prepare("SELECT * FROM tab_activity_stream_cursors").all(),
            daily: database.prepare("SELECT * FROM logical_page_activity_daily").all(),
            metrics: database.prepare("SELECT * FROM activity_ingest_metrics").all(),
            pageTotals: database.prepare("SELECT * FROM tab_page_activity_totals").all(),
            tabTotals: database.prepare("SELECT * FROM tab_activity_totals").all(),
            logicalPageCount: database.prepare("SELECT COUNT(*) FROM logical_pages").pluck().get(),
            tabCount: database.prepare("SELECT COUNT(*) FROM tabs").pluck().get(),
          };
        } finally {
          database.close();
        }
      };
      const beforeRejectedEvents = inspect();
      expect((await app.inject({
        method: "POST",
        url: "/api/ingest/activity",
        payload: {
          ...exact,
          id: "923e4567-e89b-42d3-a456-426614174000",
          sequence: 2,
          endedAt: "2026-08-12T10:02:00.001Z",
        },
      })).statusCode).toBe(400);
      expect(inspect()).toEqual(beforeRejectedEvents);
      now = new Date("2026-08-12T09:00:00.000Z");
      expect((await app.inject({
        method: "POST",
        url: "/api/ingest/activity",
        payload: exact,
      })).statusCode).toBe(400);
      expect(inspect()).toEqual(beforeRejectedEvents);
      expect((await app.inject({
        method: "POST",
        url: "/api/ingest/activity",
        payload: {
          ...exact,
          id: "b23e4567-e89b-42d3-a456-426614174000",
          sequence: 1,
        },
      })).statusCode).toBe(400);
      expect(inspect()).toEqual(beforeRejectedEvents);
      now = new Date("2026-08-12T12:00:00.000Z");
      expect((await app.inject({
        method: "POST",
        url: "/api/ingest/activity",
        payload: {
          ...exact,
          id: "a23e4567-e89b-42d3-a456-426614174000",
          sequence: 3,
          startedAt: "2026-08-12T12:00:00.000Z",
          endedAt: "2026-08-12T12:00:01.000Z",
          foregroundMs: 1_000,
          engagedMs: 500,
        },
      })).statusCode).toBe(400);
      expect(inspect()).toEqual(beforeRejectedEvents);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves G3 resources and lifetime ingest while both G4 flags are off", async () => {
    const value = await fixture({});
    try {
      expect((await value.app.inject({ method: "GET", url: "/api/features" })).json())
        .toMatchObject({ resources: true, activityWindows: false });
      const first = activity(1, "323e4567-e89b-42d3-a456-426614174000");
      const gap = activity(3, "423e4567-e89b-42d3-a456-426614174000");
      expect((await value.app.inject({ method: "POST", url: "/api/ingest/activity",
        payload: first })).json()).toEqual({ accepted: true });
      expect((await value.app.inject({ method: "POST", url: "/api/ingest/activity",
        payload: gap })).json()).toEqual({ accepted: true });
      expect((await value.app.inject({ method: "POST", url: "/api/ingest/activity",
        payload: gap })).json()).toEqual({ accepted: false });
      expect((await value.app.inject({ method: "POST", url: "/api/ingest/activity",
        payload: activity(2, "523e4567-e89b-42d3-a456-426614174000") })).json())
        .toEqual({ accepted: false });

      const all = await value.app.inject({ method: "GET",
        url: `/api/resources/${value.resourceId}/activity` });
      expect(all.statusCode).toBe(200);
      expect(all.json().activity).toMatchObject({
        window: "all", onScreenMs: 2_000, activeUseMs: 1_000,
      });
      expect((await value.app.inject({ method: "GET",
        url: `/api/resources/${value.resourceId}/activity?window=7d` })).statusCode).toBe(404);
      expect((await value.app.inject({ method: "GET",
        url: `/api/logical-pages/${value.pageId}/activity?window=7d` })).statusCode).toBe(404);
      expect((await value.app.inject({ method: "GET", url: "/api/activity/metrics" })).statusCode)
        .toBe(404);

      const database = new Database(value.databasePath, { readonly: true });
      try {
        expect(database.prepare("SELECT COUNT(*) FROM logical_page_activity_daily").pluck().get())
          .toBe(0);
        expect(database.prepare(`
          SELECT duplicate_events, out_of_order_rejections, gap_events, missing_sequences
          FROM activity_ingest_metrics WHERE singleton_id = 1
        `).get()).toEqual({
          duplicate_events: 0,
          out_of_order_rejections: 0,
          gap_events: 0,
          missing_sequences: 0,
        });
        expect(database.prepare("SELECT last_sequence FROM tab_activity_stream_cursors").pluck().get())
          .toBe(3);
      } finally {
        database.close();
      }
    } finally {
      await close(value);
    }
  });

  it("fails readers closed to G3 all-time while the writer is off", async () => {
    const value = await fixture({ activityWindows: true });
    try {
      expect((await value.app.inject({ method: "POST", url: "/api/ingest/activity",
        payload: activity(1, "623e4567-e89b-42d3-a456-426614174000") })).statusCode).toBe(200);
      expect((await value.app.inject({ method: "GET", url: "/api/features" })).json())
        .toMatchObject({ resources: true, activityWindows: false });
      expect((await value.app.inject({ method: "GET",
        url: `/api/resources/${value.resourceId}/activity?window=7d` })).statusCode).toBe(404);
      expect((await value.app.inject({ method: "GET",
        url: `/api/logical-pages/${value.pageId}/activity?window=7d` })).statusCode).toBe(404);
      expect((await value.app.inject({ method: "GET", url: "/api/activity/metrics" })).statusCode)
        .toBe(404);
      expect((await value.app.inject({ method: "GET",
        url: `/api/resources/${value.resourceId}/activity` })).json().activity)
        .toMatchObject({ window: "all", onScreenMs: 1_000, activeUseMs: 500 });
    } finally {
      await close(value);
    }
  });

  it("collects daily buckets while keeping reader routes and capability hidden", async () => {
    const value = await fixture({ activityDailyWriter: true });
    try {
      expect((await value.app.inject({ method: "POST", url: "/api/ingest/activity",
        payload: activity(1, "723e4567-e89b-42d3-a456-426614174000") })).statusCode).toBe(200);
      expect((await value.app.inject({ method: "GET", url: "/api/features" })).json())
        .toMatchObject({ resources: true, activityWindows: false });
      expect((await value.app.inject({ method: "GET",
        url: `/api/resources/${value.resourceId}/activity?window=30d` })).statusCode).toBe(404);
      expect((await value.app.inject({ method: "GET", url: "/api/activity/metrics" })).statusCode)
        .toBe(404);
      const database = new Database(value.databasePath, { readonly: true });
      try {
        expect(database.prepare(`
          SELECT foreground_ms, engaged_ms FROM logical_page_activity_daily
        `).get()).toEqual({ foreground_ms: 1_000, engaged_ms: 500 });
      } finally {
        database.close();
      }
    } finally {
      await close(value);
    }
  });
});
