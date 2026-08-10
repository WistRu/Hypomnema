import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { graphV2ResponseSchema } from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

describe("mixed knowledge graph v2 REST behavior", () => {
  it("projects topics, tabs, structure, membership, and typed relations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-graph-v2-"));
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
          tabs: ["Alpha", "Beta", "Untagged"].map((title, index) => ({
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
      const ids = Object.fromEntries(listed.map((tab) => [tab.title, tab.id]));
      const createTopic = async (name: string, parentId?: number) =>
        (
          await app.inject({
            method: "POST",
            url: "/api/tags",
            payload: { name, ...(parentId === undefined ? {} : { parentId }) },
          })
        ).json() as { id: number };
      const work = await createTopic("Work");
      const crypto = await createTopic("Crypto", work.id);
      const research = await createTopic("Research");
      const assign = (tabIds: number[], tagPath: string) =>
        app.inject({
          method: "POST",
          url: "/api/tags/assign",
          payload: { ids: tabIds, tagPath, assignedBy: "user" },
        });
      await assign([ids.Alpha!], "Work");
      await assign([ids.Beta!], "Work/Crypto");
      await assign([ids.Beta!], "Research");

      const createRelation = async (
        from: { type: "tab" | "topic"; id: number },
        to: { type: "tab" | "topic"; id: number },
        kind: string,
      ) =>
        (
          await app.inject({
            method: "POST",
            url: "/api/relations",
            payload: { from, to, kind, createdBy: "user" },
          })
        ).json() as { id: number };
      const workToBeta = await createRelation(
        { type: "topic", id: work.id },
        { type: "tab", id: ids.Beta! },
        "tracks",
      );
      const cryptoToResearch = await createRelation(
        { type: "topic", id: crypto.id },
        { type: "topic", id: research.id },
        "related",
      );
      const researchToUntagged = await createRelation(
        { type: "topic", id: research.id },
        { type: "tab", id: ids.Untagged! },
        "references",
      );
      const alphaToBeta = await createRelation(
        { type: "tab", id: ids.Alpha! },
        { type: "tab", id: ids.Beta! },
        "follows",
      );
      const defaultTopicRecord = (
        await app.inject({ method: "GET", url: "/api/tags" })
      )
        .json()
        .items.find((topic: { path: string }) => topic.path === "Без темы") as {
        id: number;
      };

      const allResponse = await app.inject({
        method: "GET",
        url: "/api/graph/v2",
      });
      expect(allResponse.statusCode).toBe(200);
      const all = graphV2ResponseSchema.parse(allResponse.json());
      expect(all.nodes).toHaveLength(6);
      const defaultTopic = all.nodes.find(
        (node) => node.type === "topic" && node.path === "Без темы",
      );
      expect(defaultTopic).toBeUndefined();
      expect(all.nodes).toContainEqual(
        expect.objectContaining({
          type: "tab",
          id: ids.Untagged,
          tagPaths: [],
          rootTags: [],
        }),
      );
      expect(all.nodes).toContainEqual(
        expect.objectContaining({
          type: "topic",
          id: work.id,
          path: "Work",
          directTabCount: 1,
          tabCount: 2,
        }),
      );
      expect(all.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: `containment:${work.id}:${crypto.id}`,
            edgeType: "containment",
          }),
          expect.objectContaining({
            id: `membership:${crypto.id}:${ids.Beta}`,
            edgeType: "membership",
            source: { type: "topic", id: crypto.id },
            target: { type: "tab", id: ids.Beta },
          }),
          expect.objectContaining({
            id: `relation:${cryptoToResearch.id}`,
            edgeType: "relation",
          }),
        ]),
      );
      expect(
        all.edges.some(
          (edge) =>
            edge.id === `membership:${defaultTopicRecord.id}:${ids.Untagged}`,
        ),
      ).toBe(false);

      const defaultFilteredResponse = await app.inject({
        method: "GET",
        url: `/api/graph/v2?root_topic_id=${defaultTopicRecord.id}`,
      });
      expect(defaultFilteredResponse.statusCode).toBe(200);
      const defaultFiltered = graphV2ResponseSchema.parse(
        defaultFilteredResponse.json(),
      );
      expect(
        new Set(defaultFiltered.nodes.map((node) => `${node.type}:${node.id}`)),
      ).toEqual(
        new Set([
          `topic:${research.id}`,
          `tab:${ids.Untagged}`,
        ]),
      );
      expect(defaultFiltered.edges.map((edge) => edge.id)).toEqual(
        [`relation:${researchToUntagged.id}`],
      );

      const filteredResponse = await app.inject({
        method: "GET",
        url: `/api/graph/v2?root_topic_id=${work.id}`,
      });
      expect(filteredResponse.statusCode).toBe(200);
      const filtered = graphV2ResponseSchema.parse(filteredResponse.json());
      expect(
        new Set(filtered.nodes.map((node) => `${node.type}:${node.id}`)),
      ).toEqual(
        new Set([
          `topic:${work.id}`,
          `topic:${crypto.id}`,
          `topic:${research.id}`,
          `tab:${ids.Alpha}`,
          `tab:${ids.Beta}`,
        ]),
      );
      expect(filtered.edges.map((edge) => edge.id)).toEqual(
        expect.arrayContaining([
          `containment:${work.id}:${crypto.id}`,
          `membership:${work.id}:${ids.Alpha}`,
          `membership:${crypto.id}:${ids.Beta}`,
          `membership:${research.id}:${ids.Beta}`,
          `relation:${workToBeta.id}`,
          `relation:${cryptoToResearch.id}`,
          `relation:${alphaToBeta.id}`,
        ]),
      );
      expect(filtered.edges).toContainEqual(
        expect.objectContaining({
          id: `relation:${cryptoToResearch.id}`,
          source: { type: "topic", id: crypto.id },
          target: { type: "topic", id: research.id },
        }),
      );
      expect(
        filtered.nodes.some(
          (node) => node.type === "tab" && node.id === ids.Untagged,
        ),
      ).toBe(false);
      expect(filtered.edges.map((edge) => edge.id)).not.toContain(
        `relation:${researchToUntagged.id}`,
      );

      const focusedResponse = await app.inject({
        method: "GET",
        url:
          `/api/graph/v2?root_topic_id=${work.id}` +
          `&focus_node_type=topic&focus_node_id=${crypto.id}&focus_depth=2`,
      });
      expect(focusedResponse.statusCode).toBe(200);
      const focused = graphV2ResponseSchema.parse(focusedResponse.json());
      expect(focused.nodes).toContainEqual(
        expect.objectContaining({
          type: "tab",
          id: ids.Untagged,
        }),
      );
      expect(focused.edges).toContainEqual(
        expect.objectContaining({
          id: `relation:${researchToUntagged.id}`,
          source: { type: "topic", id: research.id },
          target: { type: "tab", id: ids.Untagged },
        }),
      );

      const unknown = await app.inject({
        method: "GET",
        url: "/api/graph/v2?root_topic_id=999999",
      });
      expect(unknown.json()).toEqual({ nodes: [], edges: [] });
      const malformed = await app.inject({
        method: "GET",
        url: "/api/graph/v2?root_topic_id=not-an-id",
      });
      expect(malformed.statusCode).toBe(400);
      const partialFocus = await app.inject({
        method: "GET",
        url: "/api/graph/v2?focus_node_type=topic&focus_node_id=1",
      });
      expect(partialFocus.statusCode).toBe(400);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
