import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

const INSTALLATION_ID = "b2e2270b-034f-4402-a43b-86a16c180ed8";
const BROWSER_SESSION_ID = "ec37f3be-eec7-49e2-abaa-de036f27bb17";

async function seedPhysicalTabs(app: FastifyInstance) {
  const ingest = await app.inject({
    method: "POST",
    url: "/api/ingest/snapshot",
    payload: {
      browser: "chrome",
      installationId: INSTALLATION_ID,
      browserSessionId: BROWSER_SESSION_ID,
      tabs: [
        {
          tabId: 101,
          url: "https://example.com/duplicate#raw",
          title: "First physical copy",
          windowId: 1,
          index: 0,
          active: true,
          audible: true,
          pinned: false,
        },
        {
          tabId: 202,
          url: "https://example.com/duplicate#raw",
          title: "Second physical copy",
          windowId: 2,
          index: 4,
          active: false,
          discarded: true,
          muted: true,
          pinned: true,
        },
      ],
    },
  });
  expect(ingest.statusCode).toBe(200);

  const physical = await app.inject({
    method: "GET",
    url: "/api/tab-instances?pageSize=50",
  });
  expect(physical.statusCode).toBe(200);
  return physical.json().items as Array<{
    instanceId: number;
    browser: string;
    installationId: string;
    browserSessionId: string | null;
    browserTabId: number | null;
    url: string;
  }>;
}

function selection(tab: {
  instanceId: number;
  browser: string;
  installationId: string;
  browserSessionId: string | null;
  browserTabId: number | null;
}) {
  return {
    instanceId: tab.instanceId,
    browser: tab.browser,
    installationId: tab.installationId,
    browserSessionId: tab.browserSessionId,
    browserTabId: tab.browserTabId,
  };
}

describe("saved workspaces", () => {
  it("saves duplicate physical tabs in authoritative physical order with their runtime state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-workspaces-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      clock: () => new Date("2026-08-09T12:00:00.000Z"),
    });

    try {
      const tabs = await seedPhysicalTabs(app);
      const first = tabs.find(({ browserTabId }) => browserTabId === 101)!;
      const second = tabs.find(({ browserTabId }) => browserTabId === 202)!;
      const created = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: {
          name: "  Research set  ",
          selections: [selection(second), selection(first)],
        },
      });

      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        id: expect.any(Number),
        name: "Research set",
        itemCount: 2,
        createdAt: "2026-08-09T12:00:00.000Z",
        updatedAt: "2026-08-09T12:00:00.000Z",
        items: [
          {
            ordinal: 0,
            sourceInstanceId: first.instanceId,
            browserTabId: 101,
            url: "https://example.com/duplicate#raw",
            active: true,
            audible: true,
            muted: false,
            discarded: false,
            pinned: false,
          },
          {
            ordinal: 1,
            sourceInstanceId: second.instanceId,
            browserTabId: 202,
            url: "https://example.com/duplicate#raw",
            active: false,
            audible: false,
            muted: true,
            discarded: true,
            pinned: true,
          },
        ],
      });

      const detail = await app.inject({
        method: "GET",
        url: `/api/workspaces/${created.json().id}`,
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toEqual(created.json());
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a stale optimistic selection without saving a partial workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-stale-workspace-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      const tabs = await seedPhysicalTabs(app);
      const first = tabs.find(({ browserTabId }) => browserTabId === 101)!;
      const second = tabs.find(({ browserTabId }) => browserTabId === 202)!;
      const stale = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: {
          name: "Must stay atomic",
          selections: [
            selection(second),
            {
              ...selection(first),
              browserSessionId: "807062ee-439e-475b-adc8-76908cd2a618",
            },
          ],
        },
      });

      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({
        error: "TAB_INSTANCE_STALE",
        staleInstanceIds: [first.instanceId],
      });

      const listed = await app.inject({ method: "GET", url: "/api/workspaces" });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toEqual({ items: [] });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the latest server positions rather than stale client ordering", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-workspace-order-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      const staleTabs = await seedPhysicalTabs(app);
      const first = staleTabs.find(({ browserTabId }) => browserTabId === 101)!;
      const second = staleTabs.find(({ browserTabId }) => browserTabId === 202)!;
      const refreshed = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId: INSTALLATION_ID,
          browserSessionId: BROWSER_SESSION_ID,
          tabs: [
            {
              tabId: 101,
              url: first.url,
              title: "First moved later",
              windowId: 9,
              index: 8,
              active: false,
              muted: true,
              pinned: false,
            },
            {
              tabId: 202,
              url: second.url,
              title: "Second moved first",
              windowId: 3,
              index: 1,
              active: false,
              muted: false,
              pinned: false,
            },
          ],
        },
      });
      expect(refreshed.statusCode).toBe(200);

      const created = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: {
          name: "Fresh physical order",
          selections: [selection(first), selection(second)],
        },
      });

      expect(created.statusCode).toBe(201);
      expect(
        created.json().items.map(
          (item: { browserTabId: number; index: number; muted: boolean; windowId: number }) => ({
            browserTabId: item.browserTabId,
            index: item.index,
            muted: item.muted,
            windowId: item.windowId,
          }),
        ),
      ).toEqual([
        { browserTabId: 202, index: 1, muted: false, windowId: 3 },
        { browserTabId: 101, index: 8, muted: true, windowId: 9 },
      ]);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the saved copy after live snapshots disappear and the server restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-workspace-restart-"));
    const databasePath = join(directory, "tabhub.sqlite");

    try {
      let workspace: Record<string, unknown>;
      const firstApp = createApp({
        databasePath,
        logger: false,
        clock: () => new Date("2026-08-09T12:10:00.000Z"),
      });
      try {
        const tabs = await seedPhysicalTabs(firstApp);
        const created = await firstApp.inject({
          method: "POST",
          url: "/api/workspaces",
          payload: {
            name: "Durable research",
            selections: tabs.map(selection),
          },
        });
        expect(created.statusCode).toBe(201);
        workspace = created.json() as Record<string, unknown>;

        const emptied = await firstApp.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser: "chrome",
            installationId: INSTALLATION_ID,
            browserSessionId: BROWSER_SESSION_ID,
            tabs: [],
          },
        });
        expect(emptied.statusCode).toBe(200);
        const physical = await firstApp.inject({
          method: "GET",
          url: "/api/tab-instances",
        });
        expect(physical.json().total).toBe(0);
      } finally {
        await firstApp.close();
      }

      const reopenedApp = createApp({ databasePath, logger: false });
      try {
        const detail = await reopenedApp.inject({
          method: "GET",
          url: `/api/workspaces/${workspace!.id}`,
        });
        expect(detail.statusCode).toBe(200);
        expect(detail.json()).toEqual(workspace!);

        const list = await reopenedApp.inject({
          method: "GET",
          url: "/api/workspaces",
        });
        expect(list.json()).toEqual({
          items: [
            {
              id: workspace!.id,
              name: "Durable research",
              itemCount: 2,
              createdAt: "2026-08-09T12:10:00.000Z",
              updatedAt: "2026-08-09T12:10:00.000Z",
            },
          ],
        });
      } finally {
        await reopenedApp.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("renames and deletes a workspace without changing its saved items", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-workspace-crud-"));
    let now = new Date("2026-08-09T12:20:00.000Z");
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      clock: () => now,
    });

    try {
      const tabs = await seedPhysicalTabs(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: {
          name: "Original name",
          selections: [selection(tabs[0]!)],
        },
      });
      const original = created.json();

      now = new Date("2026-08-09T12:25:00.000Z");
      const renamed = await app.inject({
        method: "PATCH",
        url: `/api/workspaces/${original.id}`,
        payload: { name: "  Renamed workspace  " },
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toEqual({
        ...original,
        name: "Renamed workspace",
        updatedAt: "2026-08-09T12:25:00.000Z",
      });

      const deleted = await app.inject({
        method: "DELETE",
        url: `/api/workspaces/${original.id}`,
      });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toEqual({ deleted: true });

      const missing = await app.inject({
        method: "GET",
        url: `/api/workspaces/${original.id}`,
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ error: "WORKSPACE_NOT_FOUND" });

      const missingDelete = await app.inject({
        method: "DELETE",
        url: `/api/workspaces/${original.id}`,
      });
      expect(missingDelete.statusCode).toBe(404);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("saves every selected tab when a workspace contains more than 2,000 items", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-large-workspace-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      const tabCount = 2_001;
      const ingested = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId: INSTALLATION_ID,
          browserSessionId: BROWSER_SESSION_ID,
          tabs: Array.from({ length: tabCount }, (_, index) => ({
            tabId: index + 1,
            url: `https://example.com/large-workspace/${index + 1}`,
            title: `Tab ${index + 1}`,
            windowId: Math.floor(index / 500) + 1,
            index: index % 500,
            active: index === 0,
            pinned: false,
          })),
        },
      });
      expect(ingested.statusCode).toBe(200);

      const physical = await app.inject({
        method: "GET",
        url: "/api/tab-instances/bulk?browser=chrome",
      });
      expect(physical.statusCode).toBe(200);
      expect(physical.json().items).toHaveLength(tabCount);

      const created = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: {
          name: "Every physical tab",
          selections: physical.json().items.map(selection),
        },
      });

      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        name: "Every physical tab",
        itemCount: tabCount,
      });
      expect(created.json().items).toHaveLength(tabCount);
      expect(
        new Set(
          created
            .json()
            .items.map(
              (item: { sourceInstanceId: number }) => item.sourceInstanceId,
            ),
        ).size,
      ).toBe(tabCount);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires a name, at least one selection, and unique instance IDs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-workspace-validation-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      const tabs = await seedPhysicalTabs(app);
      const selected = selection(tabs[0]!);
      for (const payload of [
        { name: "   ", selections: [selected] },
        { name: "Empty", selections: [] },
        { name: "Duplicate", selections: [selected, selected] },
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/workspaces",
          payload,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: "VALIDATION_ERROR" });
      }

      const invalidRename = await app.inject({
        method: "PATCH",
        url: "/api/workspaces/1",
        payload: { name: "   " },
      });
      expect(invalidRename.statusCode).toBe(400);

      const list = await app.inject({ method: "GET", url: "/api/workspaces" });
      expect(list.json()).toEqual({ items: [] });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
