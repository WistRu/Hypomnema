import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

const INSTALLATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const BROWSER_SESSION_ID = "223e4567-e89b-42d3-a456-426614174000";
const EVENT_ID = "323e4567-e89b-42d3-a456-426614174000";

describe("tab activity ingestion", () => {
  it("exposes the combined activity of current physical copies in Library", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-library-activity-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      clock: () => new Date("2026-08-10T12:00:30.000Z"),
    });

    try {
      const snapshot = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId: INSTALLATION_ID,
          browserSessionId: BROWSER_SESSION_ID,
          tabs: [
            {
              tabId: 42,
              url: "https://example.com/shared",
              title: "First copy",
              windowId: 7,
              index: 0,
            },
            {
              tabId: 84,
              url: "https://example.com/shared",
              title: "Second copy",
              windowId: 8,
              index: 1,
            },
          ],
        },
      });
      expect(snapshot.statusCode).toBe(200);

      for (const activity of [
        {
          id: EVENT_ID,
          browserTabId: 42,
          sequence: 1,
          foregroundMs: 10_000,
          engagedMs: 4_000,
        },
        {
          id: "423e4567-e89b-42d3-a456-426614174000",
          browserTabId: 84,
          sequence: 2,
          foregroundMs: 5_000,
          engagedMs: 1_000,
        },
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/ingest/activity",
          payload: {
            ...activity,
            browser: "chrome",
            installationId: INSTALLATION_ID,
            browserSessionId: BROWSER_SESSION_ID,
            url: "https://example.com/shared",
            startedAt: "2026-08-10T12:00:00.000Z",
            endedAt: "2026-08-10T12:00:10.000Z",
          },
        });
        expect(response.statusCode).toBe(200);
      }

      const library = await app.inject({
        method: "GET",
        url: "/api/tabs?browser=chrome&pageSize=50",
      });

      expect(library.statusCode).toBe(200);
      expect(library.json().items).toEqual([
        expect.objectContaining({
          openInstanceCount: 2,
          openForegroundTimeMs: 15_000,
          openEngagedTimeMs: 5_000,
        }),
      ]);
      const canonicalId = library.json().items[0].id as number;
      const detail = await app.inject({
        method: "GET",
        url: `/api/tabs/${canonicalId}`,
      });
      expect(detail.json()).toMatchObject({
        openInstanceCount: 2,
        openForegroundTimeMs: 15_000,
        openEngagedTimeMs: 5_000,
      });

      const closedSnapshot = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId: INSTALLATION_ID,
          browserSessionId: BROWSER_SESSION_ID,
          tabs: [],
        },
      });
      expect(closedSnapshot.statusCode).toBe(200);

      const closedLibrary = await app.inject({
        method: "GET",
        url: "/api/tabs?browser=chrome&pageSize=50",
      });
      expect(closedLibrary.json().items).toEqual([
        expect.objectContaining({
          openInstanceCount: 0,
          openForegroundTimeMs: 0,
          openEngagedTimeMs: 0,
        }),
      ]);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("counts an activity interval exactly once for its physical tab", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-activity-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      clock: () => new Date("2026-08-10T12:00:30.000Z"),
    });

    try {
      const snapshot = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId: INSTALLATION_ID,
          browserSessionId: BROWSER_SESSION_ID,
          tabs: [
            {
              tabId: 42,
              url: "https://example.com/article",
              title: "Article",
              windowId: 7,
              index: 0,
              active: true,
            },
          ],
        },
      });
      expect(snapshot.statusCode).toBe(200);

      const activity = {
        id: EVENT_ID,
        browser: "chrome",
        installationId: INSTALLATION_ID,
        browserSessionId: BROWSER_SESSION_ID,
        browserTabId: 42,
        sequence: 5,
        url: "https://example.com/article",
        startedAt: "2026-08-10T12:00:00.000Z",
        endedAt: "2026-08-10T12:00:10.000Z",
        foregroundMs: 10_000,
        engagedMs: 4_000,
      };

      const first = await app.inject({
        method: "POST",
        url: "/api/ingest/activity",
        payload: activity,
      });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ accepted: true });

      const duplicate = await app.inject({
        method: "POST",
        url: "/api/ingest/activity",
        payload: activity,
      });
      expect(duplicate.statusCode).toBe(200);
      expect(duplicate.json()).toEqual({ accepted: false });

      const conflictingRetry = await app.inject({
        method: "POST",
        url: "/api/ingest/activity",
        payload: { ...activity, engagedMs: 5_000 },
      });
      expect(conflictingRetry.statusCode).toBe(409);
      expect(conflictingRetry.json()).toMatchObject({
        error: "ACTIVITY_EVENT_CONFLICT",
      });

      const staleRetry = await app.inject({
        method: "POST",
        url: "/api/ingest/activity",
        payload: {
          ...activity,
          id: "423e4567-e89b-42d3-a456-426614174000",
          sequence: 4,
          foregroundMs: 9_000,
          engagedMs: 9_000,
        },
      });
      expect(staleRetry.statusCode).toBe(200);
      expect(staleRetry.json()).toEqual({ accepted: false });

      const instances = await app.inject({
        method: "GET",
        url: "/api/tab-instances",
      });
      expect(instances.statusCode).toBe(200);
      expect(instances.json().items).toEqual([
        expect.objectContaining({
          browserTabId: 42,
          foregroundTimeMs: 10_000,
          engagedTimeMs: 4_000,
        }),
      ]);

      await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId: INSTALLATION_ID,
          browserSessionId: BROWSER_SESSION_ID,
          tabs: [
            {
              tabId: 42,
              url: "https://example.com/next",
              windowId: 7,
              index: 0,
              active: true,
            },
          ],
        },
      });
      const advancedAcrossGap = await app.inject({
        method: "POST",
        url: "/api/ingest/activity",
        payload: {
          ...activity,
          id: "523e4567-e89b-42d3-a456-426614174000",
          sequence: 8,
          url: "https://example.com/next",
          startedAt: "2026-08-10T12:00:10.000Z",
          endedAt: "2026-08-10T12:00:15.000Z",
          foregroundMs: 5_000,
          engagedMs: 1_000,
        },
      });
      expect(advancedAcrossGap.statusCode).toBe(200);
      expect(advancedAcrossGap.json()).toEqual({ accepted: true });
      const afterNavigation = await app.inject({
        method: "GET",
        url: "/api/tab-instances",
      });
      expect(afterNavigation.json().items).toEqual([
        expect.objectContaining({
          url: "https://example.com/next",
          foregroundTimeMs: 15_000,
          engagedTimeMs: 5_000,
        }),
      ]);

      await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId: INSTALLATION_ID,
          browserSessionId: "623e4567-e89b-42d3-a456-426614174000",
          tabs: [
            {
              tabId: 42,
              url: "https://example.com/next",
              windowId: 7,
              index: 0,
              active: true,
            },
          ],
        },
      });
      const nextBrowserSession = await app.inject({
        method: "GET",
        url: "/api/tab-instances",
      });
      expect(nextBrowserSession.json().items).toEqual([
        expect.objectContaining({
          browserSessionId: "623e4567-e89b-42d3-a456-426614174000",
          foregroundTimeMs: 0,
          engagedTimeMs: 0,
        }),
      ]);

      const firstInNextSession = await app.inject({
        method: "POST",
        url: "/api/ingest/activity",
        payload: {
          ...activity,
          id: "723e4567-e89b-42d3-a456-426614174000",
          browserSessionId: "623e4567-e89b-42d3-a456-426614174000",
          sequence: 1,
          url: "https://example.com/next",
          startedAt: "2026-08-10T12:00:20.000Z",
          endedAt: "2026-08-10T12:00:22.000Z",
          foregroundMs: 2_000,
          engagedMs: 1_000,
        },
      });
      expect(firstInNextSession.statusCode).toBe(200);
      expect(firstInNextSession.json()).toEqual({ accepted: true });

      const nextSessionTotals = await app.inject({
        method: "GET",
        url: "/api/tab-instances",
      });
      expect(nextSessionTotals.json().items).toEqual([
        expect.objectContaining({
          browserSessionId: "623e4567-e89b-42d3-a456-426614174000",
          foregroundTimeMs: 2_000,
          engagedTimeMs: 1_000,
        }),
      ]);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains totals when activity reaches the server before its first snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-activity-first-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      const activity = await app.inject({
        method: "POST",
        url: "/api/ingest/activity",
        payload: {
          id: EVENT_ID,
          browser: "chrome",
          installationId: INSTALLATION_ID,
          browserSessionId: BROWSER_SESSION_ID,
          browserTabId: 42,
          sequence: 1,
          url: "https://example.com/activity-first",
          startedAt: "2026-08-10T12:00:00.000Z",
          endedAt: "2026-08-10T12:00:03.000Z",
          foregroundMs: 3_000,
          engagedMs: 2_000,
        },
      });
      expect(activity.statusCode).toBe(200);

      const snapshot = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId: INSTALLATION_ID,
          browserSessionId: BROWSER_SESSION_ID,
          tabs: [
            {
              tabId: 42,
              url: "https://example.com/activity-first",
              windowId: 7,
              index: 0,
              active: true,
            },
          ],
        },
      });
      expect(snapshot.statusCode).toBe(200);

      const instances = await app.inject({
        method: "GET",
        url: "/api/tab-instances",
      });
      expect(instances.json().items).toEqual([
        expect.objectContaining({
          browserTabId: 42,
          foregroundTimeMs: 3_000,
          engagedTimeMs: 2_000,
        }),
      ]);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
