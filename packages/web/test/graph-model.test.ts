import type { GraphV2Response } from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import {
  buildGraphScene,
  graphNodeKey,
  graphNodeRefFromKey,
  middleClickTabId,
  searchGraphNodes,
  selectGraphProjection,
  selectGraphNeighborhood,
} from "../src/graph-model";

const mixedGraph: GraphV2Response = {
  nodes: [
    {
      type: "topic",
      id: 10,
      name: "Work",
      path: "Work",
      parentId: null,
      color: "#6f82ff",
      directTabCount: 0,
      tabCount: 1,
    },
    {
      type: "topic",
      id: 11,
      name: "Crypto",
      path: "Work/Crypto",
      parentId: 10,
      color: null,
      directTabCount: 1,
      tabCount: 1,
    },
    {
      type: "tab",
      id: 42,
      title: "Bitcoin research",
      url: "https://example.com/bitcoin",
      browser: "chrome",
      status: "in_progress",
      importance: 2,
      isOpen: true,
      tagPaths: ["Work/Crypto"],
      rootTags: ["Work"],
    },
  ],
  edges: [
    {
      id: "containment:10:11",
      edgeType: "containment",
      source: { type: "topic", id: 10 },
      target: { type: "topic", id: 11 },
      relationId: null,
      relationKind: null,
      note: null,
      createdBy: null,
    },
    {
      id: "membership:11:42",
      edgeType: "membership",
      source: { type: "topic", id: 11 },
      target: { type: "tab", id: 42 },
      relationId: null,
      relationKind: null,
      note: null,
      createdBy: null,
    },
  ],
};

describe("knowledge graph scene", () => {
  it("keeps tab and topic identities distinct while indexing every mixed edge", () => {
    const scene = buildGraphScene(mixedGraph);

    expect(graphNodeKey({ type: "topic", id: 42 })).toBe("topic:42");
    expect(graphNodeKey({ type: "tab", id: 42 })).toBe("tab:42");
    expect(graphNodeRefFromKey("topic:42")).toEqual({
      type: "topic",
      id: 42,
    });
    expect(scene.nodes.map((node) => node.key)).toEqual([
      "topic:10",
      "topic:11",
      "tab:42",
    ]);
    expect(scene.links.map((link) => [link.sourceKey, link.targetKey])).toEqual([
      ["topic:10", "topic:11"],
      ["topic:11", "tab:42"],
    ]);
    expect(scene.adjacency.get("topic:11")?.map(({ neighborKey }) => neighborKey))
      .toEqual(["topic:10", "tab:42"]);
  });

  it("selects an undirected neighborhood at the requested depth", () => {
    const scene = buildGraphScene(mixedGraph);

    const oneStep = selectGraphNeighborhood(scene, "topic:10", 1);
    expect([...oneStep.nodeKeys]).toEqual(["topic:10", "topic:11"]);
    expect([...oneStep.edgeIds]).toEqual(["containment:10:11"]);
    expect(oneStep.distances.get("topic:10")).toBe(0);
    expect(oneStep.distances.get("topic:11")).toBe(1);

    const twoSteps = selectGraphNeighborhood(scene, "topic:10", 2);
    expect([...twoSteps.nodeKeys]).toEqual([
      "topic:10",
      "topic:11",
      "tab:42",
    ]);
    expect([...twoSteps.edgeIds]).toEqual([
      "containment:10:11",
      "membership:11:42",
    ]);
    expect(twoSteps.distances.get("tab:42")).toBe(2);
  });

  it("searches relation targets across topic paths and tab metadata", () => {
    const scene = buildGraphScene(mixedGraph);

    expect(searchGraphNodes(scene, "crypto").map(({ key }) => key)).toEqual([
      "topic:11",
      "tab:42",
    ]);
    expect(
      searchGraphNodes(scene, "bitcoin", { excludeKey: "tab:42" }),
    ).toEqual([]);
  });

  it("routes only a middle click on a tab node to canonical close", () => {
    expect(middleClickTabId(mixedGraph.nodes[2], 1)).toBe(42);
    expect(middleClickTabId(mixedGraph.nodes[2], 0)).toBeNull();
    expect(middleClickTabId(mixedGraph.nodes[0], 1)).toBeNull();
    expect(
      middleClickTabId(
        { ...mixedGraph.nodes[2]!, type: "tab", isOpen: false },
        1,
      ),
    ).toBeNull();
    expect(middleClickTabId(null, 1)).toBeNull();
  });

  it("handles cycles, dangling edges, and clamps focus depth without looping", () => {
    const scene = buildGraphScene({
      ...mixedGraph,
      edges: [
        ...mixedGraph.edges,
        {
          id: "relation:7",
          edgeType: "relation",
          source: { type: "tab", id: 42 },
          target: { type: "topic", id: 10 },
          relationId: 7,
          relationKind: "references",
          note: null,
          createdBy: "user",
        },
        {
          id: "relation:8",
          edgeType: "relation",
          source: { type: "tab", id: 42 },
          target: { type: "tab", id: 999 },
          relationId: 8,
          relationKind: "missing target",
          note: null,
          createdBy: "agent",
        },
      ],
    });

    expect(scene.links.map(({ id }) => id)).not.toContain("relation:8");

    const minimumDepth = selectGraphNeighborhood(scene, "topic:10", 0);
    expect(minimumDepth.distances.get("topic:11")).toBe(1);
    expect(minimumDepth.distances.get("tab:42")).toBe(1);
    expect([...minimumDepth.nodeKeys]).toHaveLength(3);

    const maximumDepth = selectGraphNeighborhood(scene, "topic:10", 99);
    expect([...maximumDepth.nodeKeys]).toHaveLength(3);
    expect([...maximumDepth.edgeIds]).toHaveLength(3);

    const missing = selectGraphNeighborhood(scene, "topic:999", 3);
    expect([...missing.nodeKeys]).toEqual([]);
    expect([...missing.edgeIds]).toEqual([]);
  });

  it("ignores a cached focus projection after focus is cleared", () => {
    const staleFocus: GraphV2Response = {
      nodes: [mixedGraph.nodes[0]!],
      edges: [],
    };

    expect(selectGraphProjection(mixedGraph, staleFocus, false)).toBe(
      mixedGraph,
    );
    expect(selectGraphProjection(mixedGraph, staleFocus, true)).toBe(
      staleFocus,
    );
    expect(selectGraphProjection(mixedGraph, undefined, true)).toBe(
      mixedGraph,
    );
  });
});
