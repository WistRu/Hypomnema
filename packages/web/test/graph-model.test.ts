import type { GraphNode, TabLink } from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import {
  graphNodeSize,
  layoutGraphNodes,
  reachableFollowsBranch,
} from "../src/graph-model";

function graphNode(
  id: number,
  title: string,
  rootTags: string[],
  importance: GraphNode["importance"] = 0,
): GraphNode {
  return {
    id,
    title,
    url: `https://example.com/${id}`,
    browser: "chrome",
    status: "inbox",
    importance,
    isOpen: true,
    tagPaths: rootTags,
    rootTags,
  };
}

function edge(
  id: number,
  fromTab: number,
  toTab: number,
  kind = "follows",
): TabLink {
  return {
    id,
    fromTab,
    toTab,
    kind,
    note: null,
    createdBy: "user",
  };
}

describe("graph layout", () => {
  it("is deterministic, groups by first root tag, and sizes importance monotonically", () => {
    const nodes = [
      graphNode(3, "Gamma", [], 3),
      graphNode(2, "Beta", ["Work"], 1),
      graphNode(1, "Alpha", ["Research", "Work"], 0),
    ];

    const first = layoutGraphNodes(nodes);
    const shuffled = layoutGraphNodes([nodes[1]!, nodes[2]!, nodes[0]!]);

    expect(first).toEqual(shuffled);
    expect(first.groups.map((group) => group.label)).toEqual([
      "Research",
      "Untagged",
      "Work",
    ]);
    expect(graphNodeSize(0).width).toBeLessThan(graphNodeSize(1).width);
    expect(graphNodeSize(1).height).toBeLessThan(graphNodeSize(3).height);
  });

  it("uses the selected topic as the deterministic grouping root", () => {
    const layout = layoutGraphNodes(
      [graphNode(1, "Alpha", ["Research"]), graphNode(2, "Beta", ["Work"])],
      "Research/AI",
    );

    expect(layout.groups).toHaveLength(1);
    expect(layout.groups[0]).toMatchObject({ label: "Research/AI", count: 2 });
  });

  it("does not merge an actual Untagged topic with tabs that have no topic", () => {
    const layout = layoutGraphNodes([
      graphNode(1, "Actually tagged", ["Untagged"]),
      graphNode(2, "No topic", []),
    ]);

    expect(layout.groups).toHaveLength(2);
    expect(new Set(layout.groups.map((group) => group.id)).size).toBe(2);
  });

  it("localizes the untagged label without changing deterministic en-US ordering", () => {
    const nodes = [
      graphNode(1, "Tagged", ["Beta"]),
      graphNode(2, "No topic", []),
    ];
    const english = layoutGraphNodes(nodes);
    const localized = layoutGraphNodes(
      [...nodes].reverse(),
      "",
      (key) => key === "Untagged" ? "A-localized" : key,
    );

    expect(localized.groups.map(({ id }) => id)).toEqual(
      english.groups.map(({ id }) => id),
    );
    expect(localized.groups.find(({ id }) => id === "untagged")?.label).toBe(
      "A-localized",
    );
    expect(
      localized.nodes.map(({ node, position }) => ({ id: node.id, position })),
    ).toEqual(
      english.nodes.map(({ node, position }) => ({ id: node.id, position })),
    );
  });

  it("lays out 350 nodes once each with finite stable coordinates", () => {
    const nodes = Array.from({ length: 350 }, (_, index) =>
      graphNode(
        index + 1,
        `Tab ${String(index + 1).padStart(3, "0")}`,
        [`Topic ${index % 7}`],
        (index % 4) as GraphNode["importance"],
      ),
    );
    const startedAt = performance.now();
    const layout = layoutGraphNodes(nodes);
    const elapsed = performance.now() - startedAt;
    const positions = new Set(
      layout.nodes.map(({ position }) => `${position.x},${position.y}`),
    );

    expect(layout.nodes).toHaveLength(350);
    expect(new Set(layout.nodes.map(({ node }) => node.id)).size).toBe(350);
    expect(positions.size).toBe(350);
    expect(Number.isFinite(layout.width)).toBe(true);
    expect(Number.isFinite(layout.height)).toBe(true);
    expect(layoutGraphNodes([...nodes].reverse())).toEqual(layout);
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("directed follows branch", () => {
  it("includes the root and outgoing follows descendants while ignoring incoming and other kinds", () => {
    const edges = [
      edge(1, 1, 2),
      edge(2, 2, 3),
      edge(3, 4, 1),
      edge(4, 2, 5, "related"),
    ];

    expect([...reachableFollowsBranch(1, edges, [1, 2, 3, 4, 5])]).toEqual([
      1, 2, 3,
    ]);
  });

  it("terminates cycles and returns empty when filtering removes the root", () => {
    const cycle = [edge(1, 1, 2), edge(2, 2, 3), edge(3, 3, 1)];

    expect([...reachableFollowsBranch(1, cycle, [1, 2, 3])]).toEqual([1, 2, 3]);
    expect(reachableFollowsBranch(1, cycle, [2, 3])).toEqual(new Set());
  });
});
