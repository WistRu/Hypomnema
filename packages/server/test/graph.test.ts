import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

async function seedTabs(
  app: FastifyInstance,
  titles: string[],
): Promise<Record<string, number>> {
  const snapshot = await app.inject({
    method: "POST",
    url: "/api/ingest/snapshot",
    payload: {
      browser: "chrome",
      tabs: titles.map((title, index) => ({
        url: `https://example.com/${title.toLowerCase()}`,
        title,
        windowId: 1,
        index,
      })),
    },
  });
  expect(snapshot.statusCode).toBe(200);

  const listedTabs: Array<{ id: number; title: string }> = [];
  const pageSize = Math.min(200, titles.length);
  for (let page = 1; listedTabs.length < titles.length; page += 1) {
    const list = await app.inject({
      method: "GET",
      url: `/api/tabs?page=${page}&pageSize=${pageSize}`,
    });
    expect(list.statusCode).toBe(200);
    listedTabs.push(
      ...(list.json().items as Array<{ id: number; title: string }>),
    );
  }
  return Object.fromEntries(
    listedTabs.map((tab) => [tab.title, tab.id]),
  );
}

async function assignTag(
  app: FastifyInstance,
  ids: number[],
  tagPath: string,
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/tags/assign",
    payload: { ids, tagPath, assignedBy: "user" },
  });
  expect(response.statusCode).toBe(200);
}

describe("tab graph REST behavior", () => {
  it("returns deterministic nodes, directed edges, and complete tag roots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-graph-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      const ids = await seedTabs(app, ["Alpha", "Beta", "Gamma"]);
      await assignTag(app, [ids.Alpha!], "Work");
      await assignTag(app, [ids.Alpha!, ids.Beta!], "Research/AI");
      await app.inject({
        method: "PATCH",
        url: `/api/tabs/${ids.Beta}`,
        payload: { status: "done", importance: 2 },
      });
      const betaToAlpha = await app.inject({
        method: "POST",
        url: "/api/links",
        payload: {
          from: ids.Beta,
          to: ids.Alpha,
          kind: "follows",
          note: "Read Alpha next",
          createdBy: "user",
        },
      });
      const alphaToBeta = await app.inject({
        method: "POST",
        url: "/api/links",
        payload: {
          from: ids.Alpha,
          to: ids.Beta,
          kind: "contradicts",
          createdBy: "agent",
        },
      });

      const response = await app.inject({ method: "GET", url: "/api/graph" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        nodes: [
          {
            id: ids.Alpha,
            title: "Alpha",
            url: "https://example.com/alpha",
            browser: "chrome",
            status: "inbox",
            importance: 0,
            isOpen: true,
            tagPaths: ["Research/AI", "Work"],
            rootTags: ["Research", "Work"],
          },
          {
            id: ids.Beta,
            title: "Beta",
            url: "https://example.com/beta",
            browser: "chrome",
            status: "done",
            importance: 2,
            isOpen: true,
            tagPaths: ["Research/AI"],
            rootTags: ["Research"],
          },
          {
            id: ids.Gamma,
            title: "Gamma",
            url: "https://example.com/gamma",
            browser: "chrome",
            status: "inbox",
            importance: 0,
            isOpen: true,
            tagPaths: [],
            rootTags: [],
          },
        ],
        edges: [betaToAlpha.json(), alphaToBeta.json()],
      });

      const defaultFiltered = await app.inject({
        method: "GET",
        url: `/api/graph?root_tag=${encodeURIComponent("Без темы")}`,
      });
      expect(defaultFiltered.statusCode).toBe(200);
      expect(defaultFiltered.json()).toEqual({
        nodes: [
          expect.objectContaining({
            id: ids.Gamma,
            tagPaths: [],
            rootTags: [],
          }),
        ],
        edges: [],
      });
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("selects tag subtrees, de-duplicates nodes, and prunes crossing edges", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-graph-subtree-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      const ids = await seedTabs(app, [
        "RootDirect",
        "Child",
        "Deep",
        "Multi",
        "Outside",
      ]);
      await assignTag(app, [ids.RootDirect!], "Research");
      await assignTag(app, [ids.Child!, ids.Multi!], "Research/AI");
      await assignTag(app, [ids.Deep!], "Research/AI/Agents");
      await assignTag(app, [ids.Multi!], "Research/Data");
      await assignTag(app, [ids.Outside!], "Work");

      const links: Array<{ id: number; fromTab: number; toTab: number }> = [];
      for (const [from, to] of [
        [ids.RootDirect!, ids.Child!],
        [ids.Child!, ids.Outside!],
        [ids.Outside!, ids.Deep!],
        [ids.Deep!, ids.Multi!],
        [ids.Multi!, ids.RootDirect!],
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/links",
          payload: { from, to, kind: "related", createdBy: "agent" },
        });
        links.push(response.json());
      }

      const childSubtree = await app.inject({
        method: "GET",
        url: `/api/graph?root_tag=${encodeURIComponent(" Research / AI ")}`,
      });
      expect(childSubtree.statusCode).toBe(200);
      expect(
        childSubtree.json().nodes.map((node: { id: number }) => node.id),
      ).toEqual([ids.Child, ids.Deep, ids.Multi]);
      expect(childSubtree.json().nodes).toHaveLength(3);
      expect(childSubtree.json().edges).toEqual([links[3]]);
      expect(childSubtree.json().edges[0]).toMatchObject({
        fromTab: ids.Deep,
        toTab: ids.Multi,
      });

      const rootSubtree = await app.inject({
        method: "GET",
        url: "/api/graph?root_tag=Research",
      });
      expect(rootSubtree.statusCode).toBe(200);
      expect(
        rootSubtree.json().nodes.map((node: { id: number }) => node.id),
      ).toEqual([ids.RootDirect, ids.Child, ids.Deep, ids.Multi]);
      expect(rootSubtree.json().edges).toEqual([links[0], links[3], links[4]]);
      expect(rootSubtree.json().edges[2]).toMatchObject({
        fromTab: ids.Multi,
        toTab: ids.RootDirect,
      });

      const unknown = await app.inject({
        method: "GET",
        url: "/api/graph?root_tag=Unknown",
      });
      expect(unknown.statusCode).toBe(200);
      expect(unknown.json()).toEqual({ nodes: [], edges: [] });

      const malformed = await app.inject({
        method: "GET",
        url: "/api/graph?root_tag=Research%2F%2FAI",
      });
      expect(malformed.statusCode).toBe(400);
      const blank = await app.inject({
        method: "GET",
        url: "/api/graph?root_tag=",
      });
      expect(blank.statusCode).toBe(400);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns a unique, ordered 300+ node subtree without dangling edges", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-graph-scale-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      const selectedCount = 321;
      const selectedTitles = Array.from(
        { length: selectedCount },
        (_, index) => `Scale-${index.toString().padStart(3, "0")}`,
      );
      const ids = await seedTabs(app, [...selectedTitles, "Outside"]);
      const selectedIds = selectedTitles
        .map((title) => ids[title]!)
        .sort((left, right) => left - right);
      await assignTag(app, selectedIds, "Scale/Nodes");
      await assignTag(app, selectedIds.slice(0, 50), "Scale/Extra");
      await assignTag(app, [ids.Outside!], "Work");

      const expectedEdgeIds: number[] = [];
      for (let index = 1; index < selectedIds.length; index += 1) {
        const link = await app.inject({
          method: "POST",
          url: "/api/links",
          payload: {
            from: selectedIds[index - 1],
            to: selectedIds[index],
            kind: "follows",
            note: `Step ${index}`,
            createdBy: index % 2 === 0 ? "user" : "agent",
          },
        });
        expectedEdgeIds.push(link.json().id as number);
      }
      const crossingOut = await app.inject({
        method: "POST",
        url: "/api/links",
        payload: {
          from: selectedIds.at(-1),
          to: ids.Outside,
          createdBy: "agent",
        },
      });
      const crossingIn = await app.inject({
        method: "POST",
        url: "/api/links",
        payload: {
          from: ids.Outside,
          to: selectedIds[0],
          createdBy: "user",
        },
      });

      const allStartedAt = performance.now();
      const allResponse = await app.inject({
        method: "GET",
        url: "/api/graph",
      });
      const allElapsedMs = performance.now() - allStartedAt;
      expect(allResponse.statusCode).toBe(200);
      expect(allElapsedMs).toBeLessThan(5_000);
      expect(allResponse.json().nodes).toHaveLength(selectedCount + 1);
      expect(
        new Set(
          allResponse
            .json()
            .nodes.map((node: { id: number }) => node.id),
        ).size,
      ).toBe(selectedCount + 1);
      expect(
        allResponse.json().edges.map((edge: { id: number }) => edge.id),
      ).toEqual([
        ...expectedEdgeIds,
        crossingOut.json().id,
        crossingIn.json().id,
      ]);

      const filteredStartedAt = performance.now();
      const response = await app.inject({
        method: "GET",
        url: "/api/graph?root_tag=Scale",
      });
      const filteredElapsedMs = performance.now() - filteredStartedAt;

      expect(response.statusCode).toBe(200);
      expect(filteredElapsedMs).toBeLessThan(5_000);
      const graph = response.json() as {
        nodes: Array<{
          id: number;
          tagPaths: string[];
          rootTags: string[];
        }>;
        edges: Array<{ id: number; fromTab: number; toTab: number }>;
      };
      expect(graph.nodes).toHaveLength(selectedCount);
      expect(new Set(graph.nodes.map(({ id }) => id)).size).toBe(selectedCount);
      expect(graph.nodes.map(({ id }) => id)).toEqual(selectedIds);
      expect(graph.nodes.slice(0, 50)).toEqual(
        expect.arrayContaining(
          graph.nodes.slice(0, 50).map((node) =>
            expect.objectContaining({
              tagPaths: ["Scale/Extra", "Scale/Nodes"],
              rootTags: ["Scale"],
            }),
          ),
        ),
      );
      expect(graph.edges.map(({ id }) => id)).toEqual(expectedEdgeIds);
      const nodeIds = new Set(graph.nodes.map(({ id }) => id));
      expect(
        graph.edges.every(
          ({ fromTab, toTab }) => nodeIds.has(fromTab) && nodeIds.has(toTab),
        ),
      ).toBe(true);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
