import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tabCommandRelayProtocolVersion } from "@tabhub/shared";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";

import { createApp } from "../src/app.js";

describe("personal retention REST behavior", () => {
  it(
    "explains why a closed low-footprint page is worth reviewing",
    async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "tabhub-retention-review-"),
      );
      const app = createApp({
        databasePath: join(directory, "tabhub.sqlite"),
        logger: false,
        clock: () => new Date("2026-08-12T12:00:00.000Z"),
      });

      try {
        await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser: "chrome",
            installationId: "122e4567-e89b-42d3-a456-426614174000",
            browserSessionId: "222e4567-e89b-42d3-a456-426614174000",
            tabs: [
              {
                tabId: 41,
                url: "https://www.google.com/search?q=one-off+postcode",
                title: "one-off postcode - Google Search",
                windowId: 1,
                index: 0,
              },
            ],
          },
        });
        await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser: "chrome",
            installationId: "122e4567-e89b-42d3-a456-426614174000",
            browserSessionId: "222e4567-e89b-42d3-a456-426614174000",
            tabs: [],
          },
        });

        const response = await app.inject({
          method: "GET",
          url: "/api/retention/review?pageSize=10",
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          total: 1,
          page: 1,
          pageSize: 10,
          items: [
            {
              score: expect.any(Number),
              reasons: expect.arrayContaining([
                "closed",
                "search_results",
                "no_captured_content",
                "no_engaged_activity",
              ]),
              warnings: [],
              tab: {
                title: "one-off postcode - Google Search",
                isOpen: false,
              },
            },
          ],
        });
      } finally {
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    "learns an explicit keep decision and defers a later decision",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tabhub-retention-decide-"));
      let now = new Date("2026-08-12T12:00:00.000Z");
      const app = createApp({
        databasePath: join(directory, "tabhub.sqlite"),
        logger: false,
        clock: () => now,
      });

      try {
        for (const [tabId, slug] of [
          [41, "keep-me"],
          [42, "ask-later"],
        ] as const) {
          await app.inject({
            method: "POST",
            url: "/api/ingest/snapshot",
            payload: {
              browser: "chrome",
              tabs: [
                {
                  tabId,
                  url: `https://www.google.com/search?q=${slug}`,
                  title: `${slug} - Google Search`,
                  windowId: 1,
                  index: tabId,
                },
              ],
            },
          });
          await app.inject({
            method: "POST",
            url: "/api/ingest/snapshot",
            payload: { browser: "chrome", tabs: [] },
          });
        }

        const initial = await app.inject({
          method: "GET",
          url: "/api/retention/review?pageSize=10",
        });
        const ids = initial
          .json()
          .items.map((item: { tab: { id: number } }) => item.tab.id) as number[];
        expect(ids).toHaveLength(2);

        const kept = await app.inject({
          method: "PATCH",
          url: `/api/retention/tabs/${ids[0]}`,
          payload: { decision: "keep", decidedBy: "user" },
        });
        expect(kept.statusCode).toBe(200);
        expect(kept.json()).toMatchObject({
          tabId: ids[0],
          decision: "keep",
          state: "kept",
          decidedBy: "user",
          reviewAfter: null,
        });

        const deferred = await app.inject({
          method: "PATCH",
          url: `/api/retention/tabs/${ids[1]}`,
          payload: { decision: "later", decidedBy: "user" },
        });
        expect(deferred.statusCode).toBe(200);
        expect(deferred.json()).toMatchObject({
          tabId: ids[1],
          decision: "later",
          state: "deferred",
          reviewAfter: "2026-08-19T12:00:00.000Z",
        });

        const hidden = await app.inject({
          method: "GET",
          url: "/api/retention/review?pageSize=10",
        });
        expect(hidden.json()).toMatchObject({ total: 0, items: [] });

        now = new Date("2026-08-20T12:00:00.000Z");
        const dueAgain = await app.inject({
          method: "GET",
          url: "/api/retention/review?pageSize=10",
        });
        expect(dueAgain.json()).toMatchObject({
          total: 1,
          items: [{ tab: { id: ids[1] } }],
        });
      } finally {
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    "moves a confirmed closed page to reversible trash",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tabhub-retention-trash-"));
      const app = createApp({
        databasePath: join(directory, "tabhub.sqlite"),
        logger: false,
        clock: () => new Date("2026-08-12T12:00:00.000Z"),
      });

      try {
        await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser: "chrome",
            tabs: [
              {
                url: "https://www.google.com/search?q=throw-away",
                title: "throw-away - Google Search",
                windowId: 1,
                index: 0,
              },
            ],
          },
        });
        await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: { browser: "chrome", tabs: [] },
        });
        const before = await app.inject({ method: "GET", url: "/api/tabs" });
        const tabId = before.json().items[0].id as number;

        const unconfirmed = await app.inject({
          method: "PATCH",
          url: `/api/retention/tabs/${tabId}`,
          payload: { decision: "trash", decidedBy: "user" },
        });
        expect(unconfirmed.statusCode).toBe(400);

        const trashed = await app.inject({
          method: "PATCH",
          url: `/api/retention/tabs/${tabId}`,
          payload: {
            decision: "trash",
            decidedBy: "user",
            confirmed: true,
          },
        });
        expect(trashed.statusCode).toBe(200);
        expect(trashed.json()).toMatchObject({
          tabId,
          decision: "trash",
          state: "trashed",
          trashedAt: "2026-08-12T12:00:00.000Z",
          purgeAt: "2026-08-19T12:00:00.000Z",
        });

        const library = await app.inject({ method: "GET", url: "/api/tabs" });
        expect(library.json()).toMatchObject({ total: 0, items: [] });
        const trash = await app.inject({
          method: "GET",
          url: "/api/retention/trash?pageSize=10",
        });
        expect(trash.json()).toMatchObject({
          total: 1,
          items: [
            {
              tab: { id: tabId, title: "throw-away - Google Search" },
              purgeAt: "2026-08-19T12:00:00.000Z",
            },
          ],
        });

        const restored = await app.inject({
          method: "POST",
          url: `/api/retention/trash/${tabId}/restore`,
          payload: { decidedBy: "user" },
        });
        expect(restored.statusCode).toBe(200);
        expect(restored.json()).toMatchObject({
          tabId,
          decision: "keep",
          state: "kept",
          purgeAt: null,
        });
        const restoredLibrary = await app.inject({
          method: "GET",
          url: "/api/tabs",
        });
        expect(restoredLibrary.json()).toMatchObject({ total: 1 });
        const protectedReview = await app.inject({
          method: "GET",
          url: "/api/retention/review",
        });
        expect(protectedReview.json()).toMatchObject({ total: 0 });
      } finally {
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    "refuses to trash a page while a physical instance is still open",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tabhub-retention-open-"));
      const app = createApp({
        databasePath: join(directory, "tabhub.sqlite"),
        logger: false,
      });

      try {
        await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser: "chrome",
            installationId: "122e4567-e89b-42d3-a456-426614174000",
            browserSessionId: "222e4567-e89b-42d3-a456-426614174000",
            tabs: [
              {
                tabId: 41,
                url: "https://example.com/still-open",
                title: "Still open",
                windowId: 1,
                index: 0,
              },
            ],
          },
        });
        const list = await app.inject({ method: "GET", url: "/api/tabs" });
        const tabId = list.json().items[0].id as number;

        const response = await app.inject({
          method: "PATCH",
          url: `/api/retention/tabs/${tabId}`,
          payload: {
            decision: "trash",
            decidedBy: "user",
            confirmed: true,
          },
        });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({
          error: "TAB_STILL_OPEN",
          tabId,
        });
        const after = await app.inject({ method: "GET", url: "/api/tabs" });
        expect(after.json()).toMatchObject({ total: 1 });
      } finally {
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    "keeps an open page when its owning browser scope is offline",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tabhub-retention-offline-"));
      const app = createApp({
        databasePath: join(directory, "tabhub.sqlite"),
        logger: false,
      });

      try {
        await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser: "chrome",
            installationId: "122e4567-e89b-42d3-a456-426614174000",
            browserSessionId: "222e4567-e89b-42d3-a456-426614174000",
            tabs: [
              {
                tabId: 41,
                url: "https://www.google.com/search?q=offline-disposal",
                title: "offline-disposal - Google Search",
                windowId: 1,
                index: 0,
              },
            ],
          },
        });
        const list = await app.inject({ method: "GET", url: "/api/tabs" });
        const tabId = list.json().items[0].id as number;

        const response = await app.inject({
          method: "POST",
          url: `/api/retention/tabs/${tabId}/forget`,
          payload: { decidedBy: "user", confirmed: true },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          tabId,
          outcome: "blocked",
          reason: "scope_offline",
          closedInstanceCount: 0,
          purgeAt: null,
        });
        const after = await app.inject({ method: "GET", url: "/api/tabs" });
        expect(after.json()).toMatchObject({ total: 1 });
        const trash = await app.inject({
          method: "GET",
          url: "/api/retention/trash",
        });
        expect(trash.json()).toMatchObject({ total: 0 });
      } finally {
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    "does not forget a legacy-open page without an addressable physical instance",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tabhub-retention-legacy-open-"));
      const app = createApp({
        databasePath: join(directory, "tabhub.sqlite"),
        logger: false,
      });

      try {
        await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser: "chrome",
            tabs: [
              {
                url: "https://example.com/legacy-open",
                title: "Legacy open",
                windowId: 1,
                index: 0,
              },
            ],
          },
        });
        const list = await app.inject({ method: "GET", url: "/api/tabs" });
        const tabId = list.json().items[0].id as number;

        const response = await app.inject({
          method: "POST",
          url: `/api/retention/tabs/${tabId}/forget`,
          payload: { decidedBy: "user", confirmed: true },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          tabId,
          outcome: "blocked",
          reason: "unaddressable_instance",
          closedInstanceCount: 0,
          purgeAt: null,
        });
        const trash = await app.inject({ method: "GET", url: "/api/retention/trash" });
        expect(trash.json()).toMatchObject({ total: 0 });
      } finally {
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    "trashes an open page only after its exact physical close succeeds",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tabhub-retention-close-"));
      const app = createApp({
        databasePath: join(directory, "tabhub.sqlite"),
        logger: false,
        clock: () => new Date("2026-08-12T12:00:00.000Z"),
      });
      let socket: WebSocket | undefined;
      const scope = {
        browser: "chrome" as const,
        installationId: "122e4567-e89b-42d3-a456-426614174000",
        browserSessionId: "222e4567-e89b-42d3-a456-426614174000",
      };

      try {
        await app.ready();
        socket = await app.injectWS("/api/tab-command-relay/ws", {
          headers: {
            host: "127.0.0.1:7717",
            origin: "chrome-extension://tabhubtest",
          },
        });
        const ready = nextMessage(socket);
        socket.send(
          JSON.stringify({
            scope,
            type: "register",
            version: tabCommandRelayProtocolVersion,
          }),
        );
        await expect(ready).resolves.toMatchObject({ type: "ready", scope });

        await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            ...scope,
            tabs: [
              {
                tabId: 41,
                url: "https://www.google.com/search?q=close-then-forget",
                title: "close-then-forget - Google Search",
                windowId: 1,
                index: 0,
              },
            ],
          },
        });
        const list = await app.inject({ method: "GET", url: "/api/tabs" });
        const tabId = list.json().items[0].id as number;

        const previewMessage = nextMessage(socket);
        const forgetPromise = app.inject({
          method: "POST",
          url: `/api/retention/tabs/${tabId}/forget`,
          payload: { decidedBy: "user", confirmed: true },
        });
        const previewEnvelope = (await previewMessage) as {
          requestId: string;
          command: unknown;
        };
        expect(previewEnvelope.command).toEqual({
          kind: "close-preview",
          targets: [
            {
              expectedUrl:
                "https://www.google.com/search?q=close-then-forget",
              tabId: 41,
            },
          ],
        });
        socket.send(
          JSON.stringify({
            ok: true,
            requestId: previewEnvelope.requestId,
            result: {
              candidateTabIds: [41],
              expiresAt: Date.now() + 30_000,
              kind: "close-preview",
              previewId: "322e4567-e89b-42d3-a456-426614174000",
              requested: 1,
              skipped: [],
            },
            scope,
            type: "result",
            version: tabCommandRelayProtocolVersion,
          }),
        );

        const closeEnvelope = (await nextMessage(socket)) as {
          requestId: string;
          command: unknown;
        };
        expect(closeEnvelope.command).toEqual({
          confirmed: true,
          kind: "close",
          previewId: "322e4567-e89b-42d3-a456-426614174000",
        });
        await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: { ...scope, tabs: [] },
        });
        socket.send(
          JSON.stringify({
            ok: true,
            requestId: closeEnvelope.requestId,
            result: {
              failed: [],
              kind: "close",
              requested: 1,
              skipped: [],
              succeededTabIds: [41],
              undo: null,
            },
            scope,
            type: "result",
            version: tabCommandRelayProtocolVersion,
          }),
        );

        const response = await forgetPromise;
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          tabId,
          outcome: "trashed",
          reason: null,
          closedInstanceCount: 1,
          purgeAt: "2026-08-19T12:00:00.000Z",
        });
        const after = await app.inject({ method: "GET", url: "/api/tabs" });
        expect(after.json()).toMatchObject({ total: 0 });
      } finally {
        socket?.terminate();
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.each([
    {
      name: "rejects a close receipt that duplicates one target and omits another",
      failed: [] as Array<{ error: string; tabId: number }>,
      succeededTabIds: [41, 41],
      expectedClosedInstanceCount: 0,
    },
    {
      name: "reports verified successes when a close receipt is partial",
      failed: [{ error: "Tab vanished before close", tabId: 42 }],
      succeededTabIds: [41],
      expectedClosedInstanceCount: 1,
    },
  ])(
    "$name",
    async ({ failed, succeededTabIds, expectedClosedInstanceCount }) => {
      const directory = await mkdtemp(join(tmpdir(), "tabhub-retention-duplicate-receipt-"));
      const app = createApp({
        databasePath: join(directory, "tabhub.sqlite"),
        logger: false,
      });
      let socket: WebSocket | undefined;
      const scope = {
        browser: "chrome" as const,
        installationId: "122e4567-e89b-42d3-a456-426614174000",
        browserSessionId: "222e4567-e89b-42d3-a456-426614174000",
      };

      try {
        await app.ready();
        socket = await app.injectWS("/api/tab-command-relay/ws", {
          headers: {
            host: "127.0.0.1:7717",
            origin: "chrome-extension://tabhubtest",
          },
        });
        const ready = nextMessage(socket);
        socket.send(JSON.stringify({
          scope,
          type: "register",
          version: tabCommandRelayProtocolVersion,
        }));
        await ready;
        await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            ...scope,
            tabs: [41, 42].map((tabId, index) => ({
              tabId,
              url: "https://example.com/two-copies",
              title: `Copy ${tabId}`,
              windowId: 1,
              index,
            })),
          },
        });
        const tabId = (await app.inject({ method: "GET", url: "/api/tabs" }))
          .json().items[0].id as number;
        const previewMessage = nextMessage(socket);
        const forgetPromise = app.inject({
          method: "POST",
          url: `/api/retention/tabs/${tabId}/forget`,
          payload: { decidedBy: "user", confirmed: true },
        });
        const previewEnvelope = (await previewMessage) as { requestId: string };
        socket.send(JSON.stringify({
          ok: true,
          requestId: previewEnvelope.requestId,
          result: {
            candidateTabIds: [41, 42],
            expiresAt: Date.now() + 30_000,
            kind: "close-preview",
            previewId: "322e4567-e89b-42d3-a456-426614174000",
            requested: 2,
            skipped: [],
          },
          scope,
          type: "result",
          version: tabCommandRelayProtocolVersion,
        }));
        const closeEnvelope = (await nextMessage(socket)) as { requestId: string };
        socket.send(JSON.stringify({
          ok: true,
          requestId: closeEnvelope.requestId,
          result: {
            failed,
            kind: "close",
            requested: 2,
            skipped: [],
            succeededTabIds,
            undo: null,
          },
          scope,
          type: "result",
          version: tabCommandRelayProtocolVersion,
        }));

        const response = await forgetPromise;
        expect(response.json()).toMatchObject({
          outcome: "blocked",
          reason: "close_incomplete",
          closedInstanceCount: expectedClosedInstanceCount,
        });
        expect((await app.inject({ method: "GET", url: "/api/retention/trash" })).json())
          .toMatchObject({ total: 0 });
      } finally {
        socket?.terminate();
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    "purges an expired trash item from the canonical library",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tabhub-retention-purge-"));
      let now = new Date("2026-08-12T12:00:00.000Z");
      let app = createApp({
        databasePath: join(directory, "tabhub.sqlite"),
        logger: false,
        clock: () => now,
      });

      try {
        await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser: "chrome",
            tabs: [
              {
                url: "https://example.com/purge-me",
                title: "Purge me",
                windowId: 1,
                index: 0,
              },
            ],
          },
        });
        await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: { browser: "chrome", tabs: [] },
        });
        const before = await app.inject({ method: "GET", url: "/api/tabs" });
        const tabId = before.json().items[0].id as number;
        await app.inject({
          method: "POST",
          url: "/api/ingest/content",
          payload: {
            browser: "chrome",
            url: "https://example.com/purge-me",
            text: "Temporary captured information",
            htmlExcerpt: "<p>Temporary captured information</p>",
          },
        });
        const trashed = await app.inject({
          method: "PATCH",
          url: `/api/retention/tabs/${tabId}`,
          payload: {
            decision: "trash",
            decidedBy: "user",
            confirmed: true,
          },
        });
        expect(trashed.statusCode).toBe(200);

        now = new Date("2026-08-20T12:00:00.000Z");
        await app.close();
        app = createApp({
          databasePath: join(directory, "tabhub.sqlite"),
          logger: false,
          clock: () => now,
        });
        const trash = await app.inject({
          method: "GET",
          url: "/api/retention/trash",
        });
        expect(trash.json()).toMatchObject({ total: 0, items: [] });
        const detail = await app.inject({
          method: "GET",
          url: `/api/tabs/${tabId}`,
        });
        expect(detail.statusCode).toBe(404);
      } finally {
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    "cancels pending deletion when a trashed page is reopened",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tabhub-retention-reopen-"));
      const app = createApp({
        databasePath: join(directory, "tabhub.sqlite"),
        logger: false,
      });

      try {
        const snapshot = {
          browser: "chrome",
          tabs: [
            {
              url: "https://example.com/reopened",
              title: "Reopened",
              windowId: 1,
              index: 0,
            },
          ],
        };
        await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: snapshot,
        });
        await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: { browser: "chrome", tabs: [] },
        });
        const before = await app.inject({ method: "GET", url: "/api/tabs" });
        const tabId = before.json().items[0].id as number;
        await app.inject({
          method: "PATCH",
          url: `/api/retention/tabs/${tabId}`,
          payload: {
            decision: "trash",
            decidedBy: "user",
            confirmed: true,
          },
        });

        await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: snapshot,
        });

        const library = await app.inject({ method: "GET", url: "/api/tabs" });
        expect(library.json()).toMatchObject({
          total: 1,
          items: [{ id: tabId, isOpen: true }],
        });
        const trash = await app.inject({
          method: "GET",
          url: "/api/retention/trash",
        });
        expect(trash.json()).toMatchObject({ total: 0 });
      } finally {
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    "hides trashed pages from active graphs, topics, and statistics",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tabhub-retention-projections-"));
      const app = createApp({
        databasePath: join(directory, "tabhub.sqlite"),
        logger: false,
      });

      try {
        await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: {
            browser: "chrome",
            tabs: [
              {
                url: "https://example.com/forget-everywhere",
                title: "Forget everywhere",
                windowId: 1,
                index: 0,
              },
            ],
          },
        });
        const list = await app.inject({ method: "GET", url: "/api/tabs" });
        const tabId = list.json().items[0].id as number;
        await app.inject({
          method: "POST",
          url: "/api/tags/assign",
          payload: { ids: [tabId], tagPath: "Temporary", assignedBy: "user" },
        });
        await app.inject({
          method: "POST",
          url: "/api/ingest/snapshot",
          payload: { browser: "chrome", tabs: [] },
        });
        await app.inject({
          method: "PATCH",
          url: `/api/retention/tabs/${tabId}`,
          payload: {
            decision: "trash",
            decidedBy: "user",
            confirmed: true,
          },
        });

        const [graph, graphV2, tags, stats] = await Promise.all([
          app.inject({ method: "GET", url: "/api/graph" }),
          app.inject({ method: "GET", url: "/api/graph/v2" }),
          app.inject({ method: "GET", url: "/api/tags" }),
          app.inject({ method: "GET", url: "/api/stats" }),
        ]);
        expect(graph.json().nodes).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ id: tabId })]),
        );
        expect(graphV2.json().nodes).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "tab", id: tabId }),
          ]),
        );
        expect(
          tags.json().items.find((tag: { path: string }) => tag.path === "Temporary"),
        ).toMatchObject({ tabCount: 0 });
        expect(stats.json()).toMatchObject({ total: 0, open: 0 });
        expect(
          stats.json().byTag.find((tag: { path: string }) => tag.path === "Temporary"),
        ).toMatchObject({ total: 0 });
      } finally {
        await app.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()));
      } catch (error) {
        reject(error);
      }
    });
  });
}
