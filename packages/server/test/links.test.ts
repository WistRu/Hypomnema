import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

async function seedTabs(app: FastifyInstance): Promise<Record<string, number>> {
  const response = await app.inject({
    method: "POST",
    url: "/api/ingest/snapshot",
    payload: {
      browser: "chrome",
      tabs: ["Alpha", "Beta", "Gamma"].map((title, index) => ({
        url: `https://example.com/${title.toLowerCase()}`,
        title,
        windowId: 1,
        index,
      })),
    },
  });
  expect(response.statusCode).toBe(200);

  const list = await app.inject({
    method: "GET",
    url: "/api/tabs?pageSize=10",
  });
  expect(list.statusCode).toBe(200);

  return Object.fromEntries(
    (list.json().items as Array<{ id: number; title: string }>).map((tab) => [
      tab.title,
      tab.id,
    ]),
  );
}

describe("link CRUD REST behavior", () => {
  it("creates, lists, filters, edits, and deletes directed links with provenance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-links-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      const tabs = await seedTabs(app);
      const alpha = tabs.Alpha!;
      const beta = tabs.Beta!;
      const gamma = tabs.Gamma!;

      const defaultLink = await app.inject({
        method: "POST",
        url: "/api/links",
        payload: { from: alpha, to: beta, createdBy: "agent" },
      });
      expect(defaultLink.statusCode).toBe(201);
      expect(defaultLink.json()).toMatchObject({
        fromTab: alpha,
        toTab: beta,
        kind: "related",
        note: null,
        createdBy: "agent",
      });

      const followsLink = await app.inject({
        method: "POST",
        url: "/api/links",
        payload: {
          from: beta,
          to: alpha,
          kind: "follows",
          note: "Read Alpha next",
          createdBy: "user",
        },
      });
      expect(followsLink.statusCode).toBe(201);
      expect(followsLink.json()).toMatchObject({
        fromTab: beta,
        toTab: alpha,
        kind: "follows",
        note: "Read Alpha next",
        createdBy: "user",
      });

      const unrelatedLink = await app.inject({
        method: "POST",
        url: "/api/links",
        payload: {
          from: beta,
          to: gamma,
          kind: "duplicates",
          createdBy: "agent",
        },
      });
      expect(unrelatedLink.statusCode).toBe(201);

      const all = await app.inject({ method: "GET", url: "/api/links" });
      expect(all.statusCode).toBe(200);
      expect(all.json().items.map((link: { id: number }) => link.id)).toEqual([
        defaultLink.json().id,
        followsLink.json().id,
        unrelatedLink.json().id,
      ]);

      const filtered = await app.inject({
        method: "GET",
        url: `/api/links?tab_id=${alpha}`,
      });
      expect(filtered.statusCode).toBe(200);
      expect(filtered.json().items).toEqual([
        defaultLink.json(),
        followsLink.json(),
      ]);

      const edited = await app.inject({
        method: "PATCH",
        url: `/api/links/${defaultLink.json().id}`,
        payload: { kind: "contradicts", note: "Different evidence" },
      });
      expect(edited.statusCode).toBe(200);
      expect(edited.json()).toEqual({
        ...defaultLink.json(),
        kind: "contradicts",
        note: "Different evidence",
      });

      const deleted = await app.inject({
        method: "DELETE",
        url: `/api/links/${followsLink.json().id}`,
      });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toEqual({ deleted: true });

      const afterDelete = await app.inject({
        method: "GET",
        url: `/api/links?tab_id=${alpha}`,
      });
      expect(afterDelete.json().items).toEqual([edited.json()]);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects missing endpoints and self-links without creating partial state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-link-errors-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      const tabs = await seedTabs(app);
      const alpha = tabs.Alpha!;

      const selfLink = await app.inject({
        method: "POST",
        url: "/api/links",
        payload: { from: alpha, to: alpha, createdBy: "user" },
      });
      expect(selfLink.statusCode).toBe(400);
      expect(selfLink.json()).toMatchObject({
        error: "SELF_LINK_NOT_ALLOWED",
        tabId: alpha,
      });

      const missingEndpoints = await app.inject({
        method: "POST",
        url: "/api/links",
        payload: {
          from: alpha,
          to: 999_999,
          kind: "related",
          createdBy: "agent",
        },
      });
      expect(missingEndpoints.statusCode).toBe(404);
      expect(missingEndpoints.json()).toMatchObject({
        error: "TAB_NOT_FOUND",
        missingIds: [999_999],
      });

      const twoMissingEndpoints = await app.inject({
        method: "POST",
        url: "/api/links",
        payload: { from: 999_998, to: 999_999, createdBy: "agent" },
      });
      expect(twoMissingEndpoints.statusCode).toBe(404);
      expect(twoMissingEndpoints.json().missingIds).toEqual([
        999_998, 999_999,
      ]);

      const afterFailedCreates = await app.inject({
        method: "GET",
        url: "/api/links",
      });
      expect(afterFailedCreates.json()).toEqual({ items: [] });

      const emptyPatch = await app.inject({
        method: "PATCH",
        url: "/api/links/999999",
        payload: {},
      });
      expect(emptyPatch.statusCode).toBe(400);

      const missingPatch = await app.inject({
        method: "PATCH",
        url: "/api/links/999999",
        payload: { note: null },
      });
      expect(missingPatch.statusCode).toBe(404);
      expect(missingPatch.json()).toMatchObject({ error: "LINK_NOT_FOUND" });

      const missingDelete = await app.inject({
        method: "DELETE",
        url: "/api/links/999999",
      });
      expect(missingDelete.statusCode).toBe(404);
      expect(missingDelete.json()).toMatchObject({ error: "LINK_NOT_FOUND" });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
