import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { createTabInstanceCatalog } from "../src/tab-instance-catalog.js";

describe("physical tab instances", () => {
  it("retains every modern browser tab occurrence while canonical tabs stay deduplicated", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-instances-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      clock: () => new Date("2026-08-09T10:00:00.000Z"),
    });

    try {
      const ingest = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId: "3d0efba9-e7a6-4ca8-b672-804e08b9c243",
          tabs: [
            {
              tabId: 101,
              url: "https://example.com/read",
              title: "First occurrence",
              windowId: 1,
              index: 0,
              active: true,
              audible: true,
              discarded: true,
              muted: true,
              pinned: false,
              lastAccessed: 1_754_737_100_000,
            },
            {
              tabId: 202,
              url: "https://example.com/read",
              title: "Second occurrence",
              windowId: 2,
              index: 4,
              active: false,
              pinned: true,
              lastAccessed: 1_754_737_000_000,
            },
          ],
        },
      });

      expect(ingest.statusCode).toBe(200);
      expect(ingest.json()).toEqual({ upserted: 1, closed: 0 });

      const physical = await app.inject({
        method: "GET",
        url: "/api/tab-instances?pageSize=50",
      });

      expect(physical.statusCode).toBe(200);
      expect(physical.json()).toMatchObject({
        total: 2,
        page: 1,
        pageSize: 50,
        items: expect.arrayContaining([
          expect.objectContaining({
            canonicalTabId: expect.any(Number),
            installationId: "3d0efba9-e7a6-4ca8-b672-804e08b9c243",
            browserTabId: 101,
            title: "First occurrence",
            active: true,
            audible: true,
            discarded: true,
            muted: true,
            pinned: false,
            duplicateGroupSize: 2,
          }),
          expect.objectContaining({
            canonicalTabId: expect.any(Number),
            installationId: "3d0efba9-e7a6-4ca8-b672-804e08b9c243",
            browserTabId: 202,
            title: "Second occurrence",
            active: false,
            pinned: true,
            duplicateGroupSize: 2,
          }),
        ]),
      });
      const physicalItems = physical.json().items as Array<{
        instanceId: number;
        canonicalTabId: number;
      }>;
      expect(new Set(physicalItems.map(({ instanceId }) => instanceId)).size).toBe(
        2,
      );
      expect(new Set(physicalItems.map(({ canonicalTabId }) => canonicalTabId)).size).toBe(
        1,
      );

      const searched = await app.inject({
        method: "GET",
        url: "/api/tab-instances?q=Second&pageSize=1",
      });
      expect(searched.json()).toMatchObject({
        total: 1,
        page: 1,
        pageSize: 1,
        items: [{ browserTabId: 202, title: "Second occurrence" }],
      });

      const canonical = await app.inject({
        method: "GET",
        url: "/api/tabs?browser=chrome&pageSize=50",
      });
      expect(canonical.json()).toMatchObject({ total: 1 });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns every filtered physical occurrence from the bulk endpoint without a page limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-instance-bulk-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      clock: () => new Date("2026-08-09T10:00:00.000Z"),
    });
    const installationId = "e875c8d9-c2b4-4a70-98c1-31c9c8b03513";

    try {
      const ingest = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId,
          tabs: [
            ...Array.from({ length: 251 }, (_, index) => ({
              tabId: index + 1,
              url: "https://bulk.example/exact",
              title: `Bulk selection ${index + 1}`,
              windowId: 1,
              index,
            })),
            {
              tabId: 252,
              url: "https://bulk.example/unique",
              title: "Excluded unique tab",
              windowId: 2,
              index: 0,
            },
          ],
        },
      });
      expect(ingest.statusCode).toBe(200);

      const bulk = await app.inject({
        method: "GET",
        url: "/api/tab-instances/bulk?browser=chrome&duplicates_only=true&q=Bulk+selection",
      });

      expect(bulk.statusCode).toBe(200);
      expect(bulk.json()).toMatchObject({
        total: 251,
        items: expect.arrayContaining([
          expect.objectContaining({
            installationId,
            browserTabId: 1,
            duplicateGroupSize: 251,
          }),
          expect.objectContaining({
            installationId,
            browserTabId: 251,
            duplicateGroupSize: 251,
          }),
        ]),
      });
      const items = bulk.json().items as Array<{ instanceId: number }>;
      expect(items).toHaveLength(251);
      expect(new Set(items.map(({ instanceId }) => instanceId)).size).toBe(251);
      expect(bulk.json()).not.toHaveProperty("page");
      expect(bulk.json()).not.toHaveProperty("pageSize");
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it(
    "returns more instances than SQLite permits as variables in one statement",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tabhub-instance-bulk-large-"));
      const app = createApp({
        databasePath: join(directory, "tabhub.sqlite"),
        logger: false,
      });
      const tabCount = 33_000;

      try {
        const ingest = await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser: "chrome",
            installationId: "e3ba1525-47ec-4350-a0ec-777814958933",
            tabs: Array.from({ length: tabCount }, (_, index) => ({
              tabId: index + 1,
              url: `https://large.example/${index}`,
              windowId: 1,
              index,
            })),
          },
        });
        expect(ingest.statusCode).toBe(200);

        const bulk = await app.inject({
          method: "GET",
          url: "/api/tab-instances/bulk?browser=chrome",
        });

        expect(bulk.statusCode).toBe(200);
        expect(bulk.json()).toMatchObject({ total: tabCount });
        expect(bulk.json().items).toHaveLength(tabCount);
      } finally {
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it("reads bulk instances and their tag paths from one database snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-instance-bulk-read-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const app = createApp({ databasePath, logger: false });

    try {
      const ingested = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId: "ef95fd3f-78da-4555-898d-e3aa2197461b",
          tabs: [
            {
              tabId: 1,
              url: "https://snapshot.example/tagged",
              title: "Tagged bulk instance",
              windowId: 1,
              index: 0,
            },
          ],
        },
      });
      expect(ingested.statusCode).toBe(200);
    } finally {
      await app.close();
    }

    const reader = openDatabase(databasePath);
    const writer = openDatabase(databasePath);
    const canonicalTabId = (
      writer.connection.prepare("SELECT id FROM tabs").get() as { id: number }
    ).id;
    const tagId = Number(
      writer.connection
        .prepare("INSERT INTO tags (name, parent_id) VALUES ('Snapshot', NULL)")
        .run().lastInsertRowid,
    );
    writer.connection
      .prepare(
        "INSERT INTO tab_tags (tab_id, tag_id, assigned_by) VALUES (?, ?, 'user')",
      )
      .run(canonicalTabId, tagId);
    let assignmentDeletedDuringRead = false;
    const connection = new Proxy(reader.connection, {
      get(target, property) {
        if (property === "prepare") {
          return (source: string) => {
            const statement = target.prepare(source);
            if (!source.includes("SELECT *\n            FROM instances")) {
              return statement;
            }

            return new Proxy(statement, {
              get(statementTarget, statementProperty) {
                if (statementProperty === "all") {
                  return (...parameters: unknown[]) => {
                    const rows = Reflect.apply(
                      statementTarget.all,
                      statementTarget,
                      parameters,
                    );
                    writer.connection.prepare("DELETE FROM tab_tags").run();
                    assignmentDeletedDuringRead = true;
                    return rows;
                  };
                }

                const value = Reflect.get(
                  statementTarget,
                  statementProperty,
                  statementTarget,
                ) as unknown;
                return typeof value === "function"
                  ? value.bind(statementTarget)
                  : value;
              },
            });
          };
        }

        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof reader.connection;

    try {
      const result = createTabInstanceCatalog(connection).listAllInstances({
        browser: undefined,
        duplicatesOnly: false,
        q: undefined,
      });

      expect(assignmentDeletedDuringRead).toBe(true);
      expect(result).toMatchObject({
        total: 1,
        items: [{ browserTabId: 1, tagPaths: ["Snapshot"] }],
      });
    } finally {
      writer.close();
      reader.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("round-trips and updates browser session identity for a modern physical tab", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-instance-session-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });
    const installationId = "b0b28810-ce8a-481f-9015-1a3468ff93c6";
    const firstBrowserSessionId = "c3829c8a-63be-4b9c-9fb2-7f0f86a91a37";
    const secondBrowserSessionId = "0d8d01c7-a1f5-4543-a3c8-39995d77890e";

    try {
      const firstIngest = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId,
          browserSessionId: firstBrowserSessionId,
          tabs: [
            {
              tabId: 42,
              url: "https://example.com/session-round-trip",
              title: "First browser session",
              windowId: 1,
              index: 0,
            },
          ],
        },
      });
      expect(firstIngest.statusCode).toBe(200);

      const firstPhysical = await app.inject({
        method: "GET",
        url: "/api/tab-instances?pageSize=50",
      });
      expect(firstPhysical.json()).toMatchObject({
        total: 1,
        items: [
          expect.objectContaining({
            installationId,
            browserTabId: 42,
            browserSessionId: firstBrowserSessionId,
          }),
        ],
      });

      const secondIngest = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId,
          browserSessionId: secondBrowserSessionId,
          tabs: [
            {
              tabId: 42,
              url: "https://example.com/session-round-trip",
              title: "Second browser session",
              windowId: 2,
              index: 3,
            },
          ],
        },
      });
      expect(secondIngest.statusCode).toBe(200);

      const secondPhysical = await app.inject({
        method: "GET",
        url: "/api/tab-instances?pageSize=50",
      });
      expect(secondPhysical.json()).toMatchObject({
        total: 1,
        items: [
          expect.objectContaining({
            installationId,
            browserTabId: 42,
            browserSessionId: secondBrowserSessionId,
            title: "Second browser session",
            windowId: 2,
            index: 3,
          }),
        ],
      });
      expect(JSON.stringify(secondPhysical.json())).not.toContain(
        firstBrowserSessionId,
      );
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exposes null browser session identity for legacy and tokenless modern snapshots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-null-session-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });
    const installationId = "683cb0e6-ea45-4fe6-b60c-fd827fea0c93";

    try {
      const legacyIngest = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "edge",
          tabs: [
            {
              url: "https://example.com/legacy-null-session",
              windowId: 1,
              index: 0,
            },
          ],
        },
      });
      const modernIngest = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId,
          tabs: [
            {
              tabId: 91,
              url: "https://example.com/modern-null-session",
              windowId: 1,
              index: 0,
            },
          ],
        },
      });
      expect(legacyIngest.statusCode).toBe(200);
      expect(modernIngest.statusCode).toBe(200);

      const physical = await app.inject({
        method: "GET",
        url: "/api/tab-instances?pageSize=50",
      });
      expect(physical.json()).toMatchObject({
        total: 2,
        items: expect.arrayContaining([
          expect.objectContaining({
            installationId: "legacy:edge",
            browserTabId: null,
            url: "https://example.com/legacy-null-session",
            browserSessionId: null,
          }),
          expect.objectContaining({
            installationId,
            browserTabId: 91,
            url: "https://example.com/modern-null-session",
            browserSessionId: null,
          }),
        ]),
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replaces only one installation snapshot and reconciles canonical open state across installations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-instance-sources-"));
    let now = new Date("2026-08-09T10:00:00.000Z");
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      clock: () => now,
    });
    const firstInstallation = "9782b5f9-ee11-4492-9189-289d9aa9c808";
    const secondInstallation = "d4cc78d9-efb3-4411-8b8f-3443e794a429";

    try {
      for (const [installationId, tabs] of [
        [
          firstInstallation,
          [
            { tabId: 1, url: "https://example.com/shared", windowId: 1, index: 0 },
            { tabId: 2, url: "https://example.com/only-a", windowId: 1, index: 1 },
          ],
        ],
        [
          secondInstallation,
          [
            { tabId: 3, url: "https://example.com/shared", windowId: 2, index: 0 },
            { tabId: 4, url: "https://example.com/only-b", windowId: 2, index: 1 },
          ],
        ],
      ] as const) {
        const response = await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: { browser: "chrome", installationId, tabs },
        });
        expect(response.statusCode).toBe(200);
      }

      now = new Date("2026-08-09T10:05:00.000Z");
      const emptied = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId: firstInstallation,
          tabs: [],
        },
      });
      expect(emptied.json()).toEqual({ upserted: 0, closed: 1 });

      const physical = await app.inject({
        method: "GET",
        url: "/api/tab-instances?pageSize=50",
      });
      expect(physical.json()).toMatchObject({
        total: 2,
        items: expect.arrayContaining([
          expect.objectContaining({
            installationId: secondInstallation,
            url: "https://example.com/shared",
          }),
          expect.objectContaining({
            installationId: secondInstallation,
            url: "https://example.com/only-b",
          }),
        ]),
      });
      expect(JSON.stringify(physical.json())).not.toContain("legacy:chrome");

      const canonical = await app.inject({
        method: "GET",
        url: "/api/tabs?browser=chrome&pageSize=50",
      });
      expect(canonical.json().items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            urlNormalized: "https://example.com/shared",
            isOpen: true,
            closedAt: null,
          }),
          expect.objectContaining({
            urlNormalized: "https://example.com/only-b",
            isOpen: true,
          }),
          expect.objectContaining({
            urlNormalized: "https://example.com/only-a",
            isOpen: false,
            closedAt: "2026-08-09T10:05:00.000Z",
          }),
        ]),
      );
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("closes the previous browser identity when one installation switches browsers without an empty transition snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-identity-switch-"));
    let now = new Date("2026-08-09T10:00:00.000Z");
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      clock: () => now,
    });
    const installationId = "9c32df58-2a16-45f0-94af-2aa22ff44ef3";

    try {
      await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId,
          tabs: [
            {
              tabId: 11,
              url: "https://example.com/chrome-only",
              windowId: 1,
              index: 0,
            },
          ],
        },
      });

      now = new Date("2026-08-09T10:05:00.000Z");
      const switched = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "edge",
          installationId,
          tabs: [
            {
              tabId: 22,
              url: "https://example.com/edge-only",
              windowId: 2,
              index: 0,
            },
          ],
        },
      });

      expect(switched.json()).toEqual({ upserted: 1, closed: 1 });
      const chromeOpen = await app.inject({
        method: "GET",
        url: "/api/tabs?browser=chrome&is_open=true",
      });
      expect(chromeOpen.json()).toMatchObject({ total: 0, items: [] });
      const chromeClosed = await app.inject({
        method: "GET",
        url: "/api/tabs?browser=chrome&is_open=false",
      });
      expect(chromeClosed.json()).toMatchObject({
        total: 1,
        items: [
          {
            url: "https://example.com/chrome-only",
            isOpen: false,
            closedAt: "2026-08-09T10:05:00.000Z",
          },
        ],
      });
      const physical = await app.inject({
        method: "GET",
        url: "/api/tab-instances?pageSize=50",
      });
      expect(physical.json()).toMatchObject({
        total: 1,
        items: [{ browser: "edge", browserTabId: 22 }],
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves a live legacy browser snapshot when a different modern installation syncs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-mixed-rollout-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      clock: () => new Date("2026-08-09T10:00:00.000Z"),
    });

    try {
      await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          tabs: [
            {
              url: "https://legacy-profile.example/one",
              windowId: 7,
              index: 0,
            },
            {
              url: "https://legacy-profile.example/two",
              windowId: 7,
              index: 1,
            },
          ],
        },
      });
      await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId: "f6e0968d-c638-441c-8509-90f64ce79aa8",
          tabs: [
            {
              tabId: 901,
              url: "https://modern-profile.example/only",
              windowId: 2,
              index: 0,
            },
          ],
        },
      });

      const physical = await app.inject({
        method: "GET",
        url: "/api/tab-instances?browser=chrome&pageSize=50",
      });
      expect(physical.json()).toMatchObject({
        total: 3,
        items: expect.arrayContaining([
          expect.objectContaining({
            installationId: "legacy:chrome",
            url: "https://legacy-profile.example/one",
          }),
          expect.objectContaining({
            installationId: "legacy:chrome",
            url: "https://legacy-profile.example/two",
          }),
          expect.objectContaining({
            installationId: "f6e0968d-c638-441c-8509-90f64ce79aa8",
            browserTabId: 901,
          }),
        ]),
      });
      const canonicalOpen = await app.inject({
        method: "GET",
        url: "/api/tabs?browser=chrome&is_open=true&pageSize=50",
      });
      expect(canonicalOpen.json().total).toBe(3);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replaces an exactly matching legacy snapshot when that browser installation upgrades", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-legacy-upgrade-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      clock: () => new Date("2026-08-09T10:00:00.000Z"),
    });

    const tabs = [
      {
        url: "https://same-profile.example/one",
        windowId: 7,
        index: 0,
      },
      {
        url: "https://same-profile.example/two",
        windowId: 7,
        index: 1,
      },
    ];

    try {
      const legacy = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: { browser: "chrome", tabs },
      });
      expect(legacy.statusCode).toBe(200);

      const modern = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId: "7d92959a-e6f8-4bba-a91c-cd1cd879229d",
          tabs: tabs.map((tab, index) => ({ ...tab, tabId: 700 + index })),
        },
      });
      expect(modern.statusCode).toBe(200);

      const physical = await app.inject({
        method: "GET",
        url: "/api/tab-instances?browser=chrome&pageSize=50",
      });
      expect(physical.json()).toMatchObject({
        total: 2,
        items: expect.arrayContaining([
          expect.objectContaining({
            installationId: "7d92959a-e6f8-4bba-a91c-cd1cd879229d",
            browserTabId: 700,
            url: "https://same-profile.example/one",
          }),
          expect.objectContaining({
            installationId: "7d92959a-e6f8-4bba-a91c-cd1cd879229d",
            browserTabId: 701,
            url: "https://same-profile.example/two",
          }),
        ]),
      });
      expect(JSON.stringify(physical.json())).not.toContain("legacy:chrome");
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns exact-URL duplicate groups with a safe deterministic close plan", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-duplicate-plan-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      clock: () => new Date("2026-08-09T10:00:00.000Z"),
    });
    const installationId = "146e9de1-3219-4127-bdc8-2f459614bcc2";

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId,
          tabs: [
            {
              tabId: 1,
              url: "https://example.com/exact",
              windowId: 1,
              index: 0,
              active: true,
              lastAccessed: 100,
            },
            {
              tabId: 2,
              url: "https://example.com/exact",
              windowId: 1,
              index: 1,
              pinned: true,
              lastAccessed: 400,
            },
            {
              tabId: 3,
              url: "https://example.com/exact",
              windowId: 1,
              index: 2,
              lastAccessed: 300,
            },
            {
              tabId: 4,
              url: "https://example.com/exact",
              windowId: 1,
              index: 3,
              lastAccessed: 200,
            },
            {
              tabId: 5,
              url: "https://example.com/article?utm_source=mail#one",
              windowId: 1,
              index: 4,
            },
            {
              tabId: 6,
              url: "https://example.com/article?utm_source=mail#two",
              windowId: 1,
              index: 5,
            },
          ],
        },
      });
      expect(response.statusCode).toBe(200);

      const duplicatesOnly = await app.inject({
        method: "GET",
        url: "/api/tab-instances?duplicates_only=true&pageSize=50",
      });
      expect(duplicatesOnly.json().total).toBe(4);

      const groups = await app.inject({
        method: "GET",
        url: "/api/duplicate-groups?browser=chrome&pageSize=50",
      });

      expect(groups.statusCode).toBe(200);
      expect(groups.json()).toMatchObject({
        totalGroups: 1,
        totalTabsInGroups: 4,
        totalDuplicateCopies: 3,
        totalCloseCandidates: 3,
        totalProtected: 1,
        page: 1,
        pageSize: 50,
        items: [
          {
            installationId,
            browser: "chrome",
            url: "https://example.com/exact",
            count: 4,
            keeperInstanceId: expect.any(Number),
            candidateInstanceIds: expect.any(Array),
            protectedInstanceIds: expect.any(Array),
            instances: expect.any(Array),
          },
        ],
      });
      const group = groups.json().items[0] as {
        keeperInstanceId: number;
        candidateInstanceIds: number[];
        protectedInstanceIds: number[];
        instances: Array<{
          instanceId: number;
          browserTabId: number;
        }>;
      };
      const instanceIdByBrowserTabId = new Map(
        group.instances.map((instance) => [
          instance.browserTabId,
          instance.instanceId,
        ]),
      );
      expect(group.keeperInstanceId).toBe(instanceIdByBrowserTabId.get(2));
      expect(group.candidateInstanceIds).toEqual([
        instanceIdByBrowserTabId.get(1),
        instanceIdByBrowserTabId.get(3),
        instanceIdByBrowserTabId.get(4),
      ]);
      expect(group.protectedInstanceIds).toEqual([
        instanceIdByBrowserTabId.get(2),
      ]);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("paginates whole duplicate groups by size and searches without trimming group members", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-duplicate-groups-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      clock: () => new Date("2026-08-09T10:00:00.000Z"),
    });

    try {
      const ingested = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId: "20fdb15a-c19d-45aa-aa93-aae02ac1be64",
          tabs: [
            {
              tabId: 1,
              url: "https://groups.example/largest",
              title: "Needle title",
              windowId: 1,
              index: 0,
            },
            {
              tabId: 2,
              url: "https://groups.example/largest",
              title: "Second copy",
              windowId: 1,
              index: 1,
            },
            {
              tabId: 3,
              url: "https://groups.example/largest",
              title: "Third copy",
              windowId: 2,
              index: 0,
            },
            {
              tabId: 4,
              url: "https://groups.example/smaller",
              title: "Other group",
              windowId: 2,
              index: 1,
            },
            {
              tabId: 5,
              url: "https://groups.example/smaller",
              title: "Other copy",
              windowId: 2,
              index: 2,
            },
          ],
        },
      });
      expect(ingested.statusCode).toBe(200);

      const firstPage = await app.inject({
        method: "GET",
        url: "/api/duplicate-groups?page=1&pageSize=1",
      });
      expect(firstPage.statusCode).toBe(200);
      expect(firstPage.json()).toMatchObject({
        totalGroups: 2,
        page: 1,
        pageSize: 1,
        items: [
          {
            url: "https://groups.example/largest",
            count: 3,
            instances: [{}, {}, {}],
          },
        ],
      });

      const secondPage = await app.inject({
        method: "GET",
        url: "/api/duplicate-groups?page=2&pageSize=1",
      });
      expect(secondPage.json()).toMatchObject({
        page: 2,
        items: [{ url: "https://groups.example/smaller", count: 2 }],
      });

      const searched = await app.inject({
        method: "GET",
        url: "/api/duplicate-groups?q=Needle&pageSize=50",
      });
      expect(searched.statusCode).toBe(200);
      expect(searched.json()).toMatchObject({
        totalGroups: 1,
        totalTabsInGroups: 3,
        totalDuplicateCopies: 2,
        items: [
          {
            url: "https://groups.example/largest",
            count: 3,
            instances: [{}, {}, {}],
          },
        ],
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns every matching duplicate group in one unpaged snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-duplicate-bulk-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      clock: () => new Date("2026-08-09T10:00:00.000Z"),
    });
    const chromeGroupCount = 205;

    try {
      const chromeTabs = Array.from(
        { length: chromeGroupCount },
        (_, groupIndex) =>
          [0, 1].map((copyIndex) => ({
            tabId: groupIndex * 2 + copyIndex + 1,
            url: `https://bulk.example/group-${String(groupIndex).padStart(3, "0")}`,
            title: `Chrome group ${groupIndex}`,
            windowId: 1,
            index: groupIndex * 2 + copyIndex,
          })),
      ).flat();
      const chromeIngest = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId: "122e4567-e89b-42d3-a456-426614174000",
          tabs: chromeTabs,
        },
      });
      expect(chromeIngest.statusCode).toBe(200);

      const edgeIngest = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "edge",
          installationId: "222e4567-e89b-42d3-a456-426614174000",
          tabs: [
            {
              tabId: 1,
              url: "https://bulk.example/edge-only",
              title: "Edge copy one",
              windowId: 1,
              index: 0,
            },
            {
              tabId: 2,
              url: "https://bulk.example/edge-only",
              title: "Edge copy two",
              windowId: 1,
              index: 1,
            },
          ],
        },
      });
      expect(edgeIngest.statusCode).toBe(200);

      const response = await app.inject({
        method: "GET",
        url: "/api/duplicate-groups/bulk?browser=chrome",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        totalGroups: chromeGroupCount,
        totalTabsInGroups: chromeGroupCount * 2,
        totalDuplicateCopies: chromeGroupCount,
        totalCloseCandidates: chromeGroupCount,
        totalProtected: 0,
      });
      expect(response.json().items).toHaveLength(chromeGroupCount);
      expect(
        new Set(
          response
            .json()
            .items.map((group: { url: string }) => group.url),
        ).size,
      ).toBe(chromeGroupCount);
      expect(
        response
          .json()
          .items.every((group: { browser: string }) => group.browser === "chrome"),
      ).toBe(true);
      expect(response.json()).not.toHaveProperty("page");
      expect(response.json()).not.toHaveProperty("pageSize");

      const searched = await app.inject({
        method: "GET",
        url: "/api/duplicate-groups/bulk?browser=chrome&q=Chrome+group+204",
      });
      expect(searched.statusCode).toBe(200);
      expect(searched.json()).toMatchObject({
        totalGroups: 1,
        totalTabsInGroups: 2,
        totalDuplicateCopies: 1,
        totalCloseCandidates: 1,
        items: [
          {
            browser: "chrome",
            url: "https://bulk.example/group-204",
            count: 2,
            instances: [{}, {}],
          },
        ],
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads every duplicate total, group, and instance from one database snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-duplicate-read-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const app = createApp({
      databasePath,
      logger: false,
      clock: () => new Date("2026-08-09T10:00:00.000Z"),
    });

    try {
      const ingested = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId: "ba8c34f1-6828-4d8c-a271-6e09de98b955",
          tabs: [
            {
              tabId: 1,
              url: "https://concurrent.example/exact",
              windowId: 1,
              index: 0,
            },
            {
              tabId: 2,
              url: "https://concurrent.example/exact",
              windowId: 1,
              index: 1,
            },
          ],
        },
      });
      expect(ingested.statusCode).toBe(200);
    } finally {
      await app.close();
    }

    const reader = openDatabase(databasePath);
    const writer = openDatabase(databasePath);
    let replacedDuringRead = false;
    const connection = new Proxy(reader.connection, {
      get(target, property) {
        if (property === "prepare") {
          return (source: string) => {
            const statement = target.prepare(source);
            if (!/SELECT\s+\*\s+FROM grouped/.test(source)) {
              return statement;
            }

            return new Proxy(statement, {
              get(statementTarget, statementProperty) {
                if (statementProperty === "all") {
                  return (...parameters: unknown[]) => {
                    const rows = Reflect.apply(
                      statementTarget.all,
                      statementTarget,
                      parameters,
                    );
                    writer.connection.prepare("DELETE FROM tab_instances").run();
                    replacedDuringRead = true;
                    return rows;
                  };
                }

                const value = Reflect.get(
                  statementTarget,
                  statementProperty,
                  statementTarget,
                ) as unknown;
                return typeof value === "function"
                  ? value.bind(statementTarget)
                  : value;
              },
            });
          };
        }

        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof reader.connection;

    try {
      const result = createTabInstanceCatalog(connection).listAllDuplicateGroups({
        browser: undefined,
      });

      expect(replacedDuringRead).toBe(true);
      expect(result).toMatchObject({
        totalGroups: 1,
        totalTabsInGroups: 2,
        totalDuplicateCopies: 1,
        items: [
          {
            count: 2,
            instances: [{ browserTabId: 1 }, { browserTabId: 2 }],
          },
        ],
      });
    } finally {
      writer.close();
      reader.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains duplicate occurrences from queued legacy snapshots by window position", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-legacy-instances-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      const ingest = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "edge",
          tabs: [
            {
              url: "https://example.com/legacy-duplicate",
              windowId: 4,
              index: 0,
            },
            {
              url: "https://example.com/legacy-duplicate",
              windowId: 7,
              index: 3,
            },
          ],
        },
      });
      expect(ingest.statusCode).toBe(200);

      const physical = await app.inject({
        method: "GET",
        url: "/api/tab-instances?browser=edge&pageSize=50",
      });
      expect(physical.json()).toMatchObject({
        total: 2,
        items: expect.arrayContaining([
          expect.objectContaining({
            installationId: "legacy:edge",
            browserTabId: null,
            windowId: 4,
            index: 0,
            duplicateGroupSize: 2,
          }),
          expect.objectContaining({
            installationId: "legacy:edge",
            browserTabId: null,
            windowId: 7,
            index: 3,
            duplicateGroupSize: 2,
          }),
        ]),
      });
      const canonical = await app.inject({
        method: "GET",
        url: "/api/tabs?browser=edge",
      });
      expect(canonical.json().total).toBe(1);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
