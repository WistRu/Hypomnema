import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchKnowledgeGraph } from "../src/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("knowledge graph API", () => {
  it("requests a bounded focus projection for a selected node", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ nodes: [], edges: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchKnowledgeGraph(7, undefined, {
        node: { type: "topic", id: 11 },
        depth: 4,
      }),
    ).resolves.toEqual({ nodes: [], edges: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/graph/v2?root_topic_id=7&focus_node_type=topic&focus_node_id=11&focus_depth=4",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });
});
