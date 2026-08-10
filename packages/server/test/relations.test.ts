import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

describe("typed relation REST behavior", () => {
  it("connects tabs and topics while preserving the legacy tab-link projection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-relations-"));
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
          tabs: ["Alpha", "Beta"].map((title, index) => ({
            url: `https://example.com/${title.toLowerCase()}`,
            title,
            windowId: 1,
            index,
          })),
        },
      });
      const tabs = (
        await app.inject({ method: "GET", url: "/api/tabs?pageSize=10" })
      ).json().items as Array<{ id: number; title: string }>;
      const alpha = tabs.find((tab) => tab.title === "Alpha")!.id;
      const beta = tabs.find((tab) => tab.title === "Beta")!.id;
      const work = (
        await app.inject({
          method: "POST",
          url: "/api/tags",
          payload: { name: "Work" },
        })
      ).json() as { id: number };
      const crypto = (
        await app.inject({
          method: "POST",
          url: "/api/tags",
          payload: { name: "Crypto", parentId: work.id },
        })
      ).json() as { id: number };

      const tabToTopic = await app.inject({
        method: "POST",
        url: "/api/relations",
        payload: {
          from: { type: "tab", id: alpha },
          to: { type: "topic", id: crypto.id },
          kind: "supports",
          note: "Primary source",
          createdBy: "user",
        },
      });
      expect(tabToTopic.statusCode).toBe(201);
      expect(tabToTopic.json()).toMatchObject({
        from: { type: "tab", id: alpha },
        to: { type: "topic", id: crypto.id },
        kind: "supports",
        note: "Primary source",
        createdBy: "user",
      });

      const topicToTopic = await app.inject({
        method: "POST",
        url: "/api/relations",
        payload: {
          from: { type: "topic", id: work.id },
          to: { type: "topic", id: crypto.id },
          createdBy: "agent",
        },
      });
      expect(topicToTopic.statusCode).toBe(201);
      expect(topicToTopic.json().kind).toBe("related");

      const legacy = await app.inject({
        method: "POST",
        url: "/api/links",
        payload: {
          from: alpha,
          to: beta,
          kind: "follows",
          createdBy: "user",
        },
      });
      expect(legacy.statusCode).toBe(201);
      const all = await app.inject({ method: "GET", url: "/api/relations" });
      expect(all.json().items).toHaveLength(3);
      expect(all.json().items).toContainEqual({
        id: legacy.json().id,
        from: { type: "tab", id: alpha },
        to: { type: "tab", id: beta },
        kind: "follows",
        note: null,
        createdBy: "user",
      });

      const filtered = await app.inject({
        method: "GET",
        url: `/api/relations?node_type=topic&node_id=${crypto.id}`,
      });
      expect(filtered.statusCode).toBe(200);
      expect(filtered.json().items).toEqual([
        tabToTopic.json(),
        topicToTopic.json(),
      ]);

      const legacyList = await app.inject({
        method: "GET",
        url: `/api/links?tab_id=${alpha}`,
      });
      expect(legacyList.json()).toEqual({ items: [legacy.json()] });
      const legacyCannotPatchTyped = await app.inject({
        method: "PATCH",
        url: `/api/links/${tabToTopic.json().id}`,
        payload: { kind: "changed" },
      });
      expect(legacyCannotPatchTyped.statusCode).toBe(404);

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/relations/${tabToTopic.json().id}`,
        payload: { kind: "evidence", note: null },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toMatchObject({ kind: "evidence", note: null });
      const deleted = await app.inject({
        method: "DELETE",
        url: `/api/relations/${topicToTopic.json().id}`,
      });
      expect(deleted.json()).toEqual({ deleted: true });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed, missing, and self endpoints atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-relation-errors-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      const topic = (
        await app.inject({
          method: "POST",
          url: "/api/tags",
          payload: { name: "Only" },
        })
      ).json() as { id: number };
      const self = await app.inject({
        method: "POST",
        url: "/api/relations",
        payload: {
          from: { type: "topic", id: topic.id },
          to: { type: "topic", id: topic.id },
          createdBy: "user",
        },
      });
      expect(self.statusCode).toBe(400);
      expect(self.json()).toMatchObject({ error: "SELF_RELATION_NOT_ALLOWED" });

      const missing = await app.inject({
        method: "POST",
        url: "/api/relations",
        payload: {
          from: { type: "topic", id: topic.id },
          to: { type: "tab", id: 999_999 },
          createdBy: "agent",
        },
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({
        error: "KNOWLEDGE_NODE_NOT_FOUND",
        missing: [{ type: "tab", id: 999_999 }],
      });
      const malformedFilter = await app.inject({
        method: "GET",
        url: "/api/relations?node_type=topic",
      });
      expect(malformedFilter.statusCode).toBe(400);
      expect(
        (await app.inject({ method: "GET", url: "/api/relations" })).json(),
      ).toEqual({ items: [] });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
