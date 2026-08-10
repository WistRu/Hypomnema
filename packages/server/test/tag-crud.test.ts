import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

describe("tag CRUD REST behavior", () => {
  it("places newly ingested tabs in the default topic", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-default-topic-"));
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
              url: "https://example.com/unsorted",
              title: "Unsorted",
              windowId: 1,
              index: 0,
            },
          ],
        },
      });

      const tree = await app.inject({ method: "GET", url: "/api/tags" });
      expect(tree.statusCode).toBe(200);
      expect(tree.json().items).toContainEqual(
        expect.objectContaining({
          name: "Без темы",
          path: "Без темы",
          tabCount: 1,
          children: [],
        }),
      );

      const tabs = await app.inject({ method: "GET", url: "/api/tabs" });
      expect(tabs.json()).toMatchObject({
        total: 1,
        items: [{ title: "Unsorted", tagPaths: ["Без темы"] }],
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("removes the default topic when a real topic is assigned", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-sort-topic-"));
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
              url: "https://example.com/sorted",
              title: "Sorted",
              windowId: 1,
              index: 0,
            },
          ],
        },
      });
      const tabs = await app.inject({ method: "GET", url: "/api/tabs" });
      const tabId = tabs.json().items[0].id as number;

      const assigned = await app.inject({
        method: "POST",
        url: "/api/tags/assign",
        payload: {
          ids: [tabId],
          tagPath: "Work",
          assignedBy: "user",
        },
      });
      expect(assigned.statusCode).toBe(200);

      const detail = await app.inject({
        method: "GET",
        url: `/api/tabs/${tabId}`,
      });
      expect(detail.json().tags).toEqual([
        expect.objectContaining({ path: "Work", assignedBy: "user" }),
      ]);

      const tree = await app.inject({ method: "GET", url: "/api/tags" });
      expect(
        tree.json().items.find((topic: { path: string }) => topic.path === "Без темы"),
      ).toMatchObject({ tabCount: 0 });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("restores the default topic after the last real topic is removed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-unsort-topic-"));
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
              url: "https://example.com/remove-last-topic",
              title: "Remove last topic",
              windowId: 1,
              index: 0,
            },
          ],
        },
      });
      const tabs = await app.inject({ method: "GET", url: "/api/tabs" });
      const tabId = tabs.json().items[0].id as number;
      const assigned = await app.inject({
        method: "POST",
        url: "/api/tags/assign",
        payload: {
          ids: [tabId],
          tagPath: "Work",
          assignedBy: "user",
        },
      });

      const removed = await app.inject({
        method: "DELETE",
        url: `/api/tabs/${tabId}/tags/${assigned.json().tagId}`,
      });
      expect(removed.statusCode).toBe(200);

      const detail = await app.inject({
        method: "GET",
        url: `/api/tabs/${tabId}`,
      });
      expect(detail.json().tags).toEqual([
        expect.objectContaining({ path: "Без темы", assignedBy: "agent" }),
      ]);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("restores the default topic when the last real topic is deleted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-delete-last-topic-"));
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
              url: "https://example.com/deleted-topic",
              title: "Deleted topic",
              windowId: 1,
              index: 0,
            },
          ],
        },
      });
      const tabs = await app.inject({ method: "GET", url: "/api/tabs" });
      const tabId = tabs.json().items[0].id as number;
      const assigned = await app.inject({
        method: "POST",
        url: "/api/tags/assign",
        payload: {
          ids: [tabId],
          tagPath: "Temporary",
          assignedBy: "user",
        },
      });

      const deleted = await app.inject({
        method: "DELETE",
        url: `/api/tags/${assigned.json().tagId}`,
      });
      expect(deleted.statusCode).toBe(200);

      const detail = await app.inject({
        method: "GET",
        url: `/api/tabs/${tabId}`,
      });
      expect(detail.json().tags).toEqual([
        expect.objectContaining({ path: "Без темы", assignedBy: "agent" }),
      ]);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects manual mutations of the default topic", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-protected-topic-"));
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
              url: "https://example.com/protected-default",
              title: "Protected default",
              windowId: 1,
              index: 0,
            },
          ],
        },
      });
      const tree = await app.inject({ method: "GET", url: "/api/tags" });
      const defaultTopic = tree
        .json()
        .items.find((topic: { path: string }) => topic.path === "Без темы") as {
        id: number;
      };
      const tabs = await app.inject({ method: "GET", url: "/api/tabs" });
      const tabId = tabs.json().items[0].id as number;

      const attempts = [
        await app.inject({
          method: "POST",
          url: "/api/tags/assign",
          payload: {
            ids: [tabId],
            tagPath: "Без темы",
            assignedBy: "user",
          },
        }),
        await app.inject({
          method: "POST",
          url: "/api/tags/assign",
          payload: {
            ids: [tabId],
            tagPath: "Без темы/Child",
            assignedBy: "user",
          },
        }),
        await app.inject({
          method: "DELETE",
          url: `/api/tabs/${tabId}/tags/${defaultTopic.id}`,
        }),
        await app.inject({
          method: "PATCH",
          url: `/api/tags/${defaultTopic.id}`,
          payload: { name: "Renamed" },
        }),
        await app.inject({
          method: "DELETE",
          url: `/api/tags/${defaultTopic.id}`,
        }),
        await app.inject({
          method: "POST",
          url: "/api/tags",
          payload: { name: "Child", parentId: defaultTopic.id },
        }),
      ];

      for (const attempt of attempts) {
        expect(attempt.statusCode).toBe(409);
        expect(attempt.json()).toMatchObject({
          error: "SYSTEM_TAG_IMMUTABLE",
        });
      }
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("enforces the default topic invariants for direct database writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-default-invariant-"));
    const databasePath = join(directory, "tabhub.sqlite");
    const app = createApp({ databasePath, logger: false });

    try {
      await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          tabs: ["Sorted", "Unsorted"].map((title, index) => ({
            url: `https://example.com/${title.toLowerCase()}`,
            title,
            windowId: 1,
            index,
          })),
        },
      });
      const listed = (
        await app.inject({ method: "GET", url: "/api/tabs?pageSize=10" })
      ).json().items as Array<{ id: number; title: string }>;
      const tabIds = Object.fromEntries(
        listed.map((tab) => [tab.title, tab.id]),
      );
      const assigned = await app.inject({
        method: "POST",
        url: "/api/tags/assign",
        payload: {
          ids: [tabIds.Sorted!],
          tagPath: "Work",
          assignedBy: "user",
        },
      });
      const temporary = await app.inject({
        method: "POST",
        url: "/api/tags",
        payload: { name: "Temporary" },
      });
      const defaultTopic = (
        await app.inject({ method: "GET", url: "/api/tags" })
      )
        .json()
        .items.find((topic: { path: string }) => topic.path === "Без темы") as {
        id: number;
      };

      const direct = new Database(databasePath);
      try {
        expect(() =>
          direct
            .prepare("INSERT INTO tags (name, parent_id) VALUES ('Child', ?)")
            .run(defaultTopic.id),
        ).toThrow("system tag cannot contain children");
        expect(() =>
          direct
            .prepare("UPDATE tags SET parent_id = ? WHERE id = ?")
            .run(defaultTopic.id, temporary.json().id),
        ).toThrow("system tag cannot contain children");
        expect(() =>
          direct
            .prepare(
              "UPDATE tab_tags SET tag_id = ? WHERE tab_id = ? AND tag_id = ?",
            )
            .run(defaultTopic.id, tabIds.Sorted!, assigned.json().tagId),
        ).toThrow("tab topic assignment keys are immutable");
        expect(() =>
          direct
            .prepare(
              "UPDATE tab_tags SET tab_id = ? WHERE tab_id = ? AND tag_id = ?",
            )
            .run(tabIds.Sorted!, tabIds.Unsorted!, defaultTopic.id),
        ).toThrow("tab topic assignment keys are immutable");
      } finally {
        direct.close();
      }

      const sorted = await app.inject({
        method: "GET",
        url: `/api/tabs/${tabIds.Sorted!}`,
      });
      const unsorted = await app.inject({
        method: "GET",
        url: `/api/tabs/${tabIds.Unsorted!}`,
      });
      expect(sorted.json().tags).toEqual([
        expect.objectContaining({ path: "Work" }),
      ]);
      expect(unsorted.json().tags).toEqual([
        expect.objectContaining({ path: "Без темы" }),
      ]);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates hierarchical tags and distinguishes conflicts from missing parents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-tag-create-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      const root = await app.inject({
        method: "POST",
        url: "/api/tags",
        payload: { name: " Work ", color: "#123456" },
      });
      expect(root.statusCode).toBe(201);
      expect(root.json()).toMatchObject({
        name: "Work",
        parentId: null,
        color: "#123456",
      });

      const child = await app.inject({
        method: "POST",
        url: "/api/tags",
        payload: { name: "Research", parentId: root.json().id },
      });
      expect(child.statusCode).toBe(201);
      expect(child.json()).toMatchObject({
        name: "Research",
        parentId: root.json().id,
        color: null,
      });

      const tree = await app.inject({ method: "GET", url: "/api/tags" });
      expect(tree.json()).toMatchObject({
        items: [
          {
            id: root.json().id,
            path: "Work",
            children: [
              {
                id: child.json().id,
                path: "Work/Research",
              },
            ],
          },
          {
            name: "Без темы",
            path: "Без темы",
            tabCount: 0,
            children: [],
          },
        ],
      });

      const duplicate = await app.inject({
        method: "POST",
        url: "/api/tags",
        payload: { name: "Research", parentId: root.json().id },
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json()).toMatchObject({ error: "TAG_CONFLICT" });

      const missingParent = await app.inject({
        method: "POST",
        url: "/api/tags",
        payload: { name: "Orphan", parentId: 999_999 },
      });
      expect(missingParent.statusCode).toBe(404);
      expect(missingParent.json()).toMatchObject({ error: "TAG_NOT_FOUND" });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("moves and renames tags without allowing hierarchy cycles or destructive parent deletion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-tag-update-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    const createTag = async (payload: Record<string, unknown>) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/tags",
        payload,
      });
      expect(response.statusCode).toBe(201);
      return response.json() as {
        id: number;
        name: string;
        parentId: number | null;
        color: string | null;
      };
    };

    try {
      const rootA = await createTag({ name: "Root A" });
      const rootB = await createTag({ name: "Root B" });
      const child = await createTag({ name: "Child", parentId: rootA.id });
      const grandchild = await createTag({
        name: "Grandchild",
        parentId: child.id,
      });
      const other = await createTag({ name: "Other", parentId: rootB.id });

      const moved = await app.inject({
        method: "PATCH",
        url: `/api/tags/${child.id}`,
        payload: { name: "Notes", parentId: rootB.id, color: "cyan" },
      });
      expect(moved.statusCode).toBe(200);
      expect(moved.json()).toEqual({
        id: child.id,
        name: "Notes",
        parentId: rootB.id,
        color: "cyan",
      });

      const tree = await app.inject({ method: "GET", url: "/api/tags" });
      expect(JSON.stringify(tree.json())).toContain("Root B/Notes/Grandchild");

      const siblingConflict = await app.inject({
        method: "PATCH",
        url: `/api/tags/${child.id}`,
        payload: { name: "Other" },
      });
      expect(siblingConflict.statusCode).toBe(409);
      expect(siblingConflict.json()).toMatchObject({ error: "TAG_CONFLICT" });

      const selfParent = await app.inject({
        method: "PATCH",
        url: `/api/tags/${rootA.id}`,
        payload: { parentId: rootA.id },
      });
      expect(selfParent.statusCode).toBe(409);
      expect(selfParent.json()).toMatchObject({
        error: "TAG_HIERARCHY_CONFLICT",
      });

      const descendantParent = await app.inject({
        method: "PATCH",
        url: `/api/tags/${rootB.id}`,
        payload: { parentId: grandchild.id },
      });
      expect(descendantParent.statusCode).toBe(409);
      expect(descendantParent.json()).toMatchObject({
        error: "TAG_HIERARCHY_CONFLICT",
      });

      const missingParent = await app.inject({
        method: "PATCH",
        url: `/api/tags/${child.id}`,
        payload: { parentId: 999_999 },
      });
      expect(missingParent.statusCode).toBe(404);
      expect(missingParent.json()).toMatchObject({ error: "TAG_NOT_FOUND" });

      const nonLeafDelete = await app.inject({
        method: "DELETE",
        url: `/api/tags/${rootB.id}`,
      });
      expect(nonLeafDelete.statusCode).toBe(409);
      expect(nonLeafDelete.json()).toMatchObject({ error: "TAG_HAS_CHILDREN" });

      for (const id of [grandchild.id, child.id, other.id, rootB.id]) {
        const deleted = await app.inject({
          method: "DELETE",
          url: `/api/tags/${id}`,
        });
        expect(deleted.statusCode).toBe(200);
        expect(deleted.json()).toEqual({ deleted: true });
      }
      const missingDelete = await app.inject({
        method: "DELETE",
        url: `/api/tags/${rootB.id}`,
      });
      expect(missingDelete.statusCode).toBe(404);
      expect(missingDelete.json()).toMatchObject({ error: "TAG_NOT_FOUND" });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves assignment provenance and unassigns one tab without affecting another", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-tag-unassign-"));
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
              url: "https://example.com/manual-tag",
              title: "Manual tag",
              windowId: 1,
              index: 0,
            },
            {
              url: "https://example.com/agent-tag",
              title: "Agent tag",
              windowId: 1,
              index: 1,
            },
          ],
        },
      });
      const list = await app.inject({
        method: "GET",
        url: "/api/tabs?pageSize=10",
      });
      const tabs = list.json().items as Array<{
        id: number;
        title: string | null;
      }>;
      const manualTabId = tabs.find(({ title }) => title === "Manual tag")!.id;
      const agentTabId = tabs.find(({ title }) => title === "Agent tag")!.id;

      const manualAssignment = await app.inject({
        method: "POST",
        url: "/api/tags/assign",
        payload: {
          ids: [manualTabId],
          tagPath: "Work/Review",
          assignedBy: "user",
        },
      });
      const tagId = manualAssignment.json().tagId as number;
      await app.inject({
        method: "POST",
        url: "/api/tags/assign",
        payload: {
          ids: [agentTabId],
          tagPath: "Work/Review",
          assignedBy: "agent",
        },
      });

      const manualDetail = await app.inject({
        method: "GET",
        url: `/api/tabs/${manualTabId}`,
      });
      const agentDetail = await app.inject({
        method: "GET",
        url: `/api/tabs/${agentTabId}`,
      });
      expect(manualDetail.json().tags).toEqual([
        expect.objectContaining({ id: tagId, assignedBy: "user" }),
      ]);
      expect(agentDetail.json().tags).toEqual([
        expect.objectContaining({ id: tagId, assignedBy: "agent" }),
      ]);

      const removed = await app.inject({
        method: "DELETE",
        url: `/api/tabs/${manualTabId}/tags/${tagId}`,
      });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toEqual({ deleted: true });

      const manualAfter = await app.inject({
        method: "GET",
        url: `/api/tabs/${manualTabId}`,
      });
      const agentAfter = await app.inject({
        method: "GET",
        url: `/api/tabs/${agentTabId}`,
      });
      expect(manualAfter.json().tags).toEqual([
        expect.objectContaining({ path: "Без темы", assignedBy: "agent" }),
      ]);
      expect(agentAfter.json().tags).toEqual([
        expect.objectContaining({ id: tagId, assignedBy: "agent" }),
      ]);

      const repeated = await app.inject({
        method: "DELETE",
        url: `/api/tabs/${manualTabId}/tags/${tagId}`,
      });
      expect(repeated.statusCode).toBe(404);
      expect(repeated.json()).toMatchObject({
        error: "TAG_ASSIGNMENT_NOT_FOUND",
      });

      const missingTab = await app.inject({
        method: "DELETE",
        url: `/api/tabs/999999/tags/${tagId}`,
      });
      expect(missingTab.statusCode).toBe(404);
      expect(missingTab.json()).toMatchObject({ error: "TAB_NOT_FOUND" });

      const missingTag = await app.inject({
        method: "DELETE",
        url: `/api/tabs/${agentTabId}/tags/999999`,
      });
      expect(missingTag.statusCode).toBe(404);
      expect(missingTag.json()).toMatchObject({ error: "TAG_NOT_FOUND" });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
