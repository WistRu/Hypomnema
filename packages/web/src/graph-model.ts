import type {
  GraphV2Edge,
  GraphV2Node,
  GraphV2Response,
  KnowledgeNodeRef,
} from "@tabhub/shared";

export type GraphNodeKey = `${KnowledgeNodeRef["type"]}:${number}`;

export type GraphSceneNode = GraphV2Node & {
  key: GraphNodeKey;
};

export interface GraphSceneLink {
  edge: GraphV2Edge;
  id: string;
  source: GraphNodeKey | GraphSceneNode;
  sourceKey: GraphNodeKey;
  target: GraphNodeKey | GraphSceneNode;
  targetKey: GraphNodeKey;
}

export interface GraphAdjacencyEntry {
  edgeId: string;
  neighborKey: GraphNodeKey;
}

export interface GraphScene {
  adjacency: Map<GraphNodeKey, GraphAdjacencyEntry[]>;
  linkById: Map<string, GraphSceneLink>;
  links: GraphSceneLink[];
  nodeByKey: Map<GraphNodeKey, GraphSceneNode>;
  nodes: GraphSceneNode[];
}

export interface GraphNeighborhood {
  distances: Map<GraphNodeKey, number>;
  edgeIds: Set<string>;
  nodeKeys: Set<GraphNodeKey>;
}

const EMPTY_GRAPH: GraphV2Response = { nodes: [], edges: [] };

export function selectGraphProjection(
  baseGraph: GraphV2Response | undefined,
  focusGraph: GraphV2Response | undefined,
  focusActive: boolean,
): GraphV2Response {
  return (focusActive ? focusGraph : undefined) ?? baseGraph ?? EMPTY_GRAPH;
}

export function graphNodeKey(ref: KnowledgeNodeRef): GraphNodeKey {
  return `${ref.type}:${ref.id}`;
}

export function graphNodeRefFromKey(key: GraphNodeKey): KnowledgeNodeRef {
  const separator = key.indexOf(":");
  return {
    type: key.slice(0, separator) as KnowledgeNodeRef["type"],
    id: Number(key.slice(separator + 1)),
  };
}

export function graphNodeRef(node: GraphV2Node): KnowledgeNodeRef {
  return { type: node.type, id: node.id };
}

export function graphNodeTitle(node: GraphV2Node): string {
  if (node.type === "topic") return node.name;
  if (node.title?.trim()) return node.title.trim();
  try {
    return new URL(node.url).hostname;
  } catch {
    return node.url;
  }
}

export function middleClickTabId(
  node: GraphV2Node | null | undefined,
  button: number,
): number | null {
  return button === 1 && node?.type === "tab" && node.isOpen ? node.id : null;
}

function graphNodeSearchText(node: GraphV2Node): string {
  return node.type === "topic"
    ? `${node.name}\n${node.path}`.toLocaleLowerCase()
    : [
        graphNodeTitle(node),
        node.url,
        node.browser,
        ...node.tagPaths,
        ...node.rootTags,
      ]
        .join("\n")
        .toLocaleLowerCase();
}

export function buildGraphScene(graph: GraphV2Response): GraphScene {
  const nodes = graph.nodes.map(
    (node): GraphSceneNode => ({ ...node, key: graphNodeKey(node) }),
  );
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const adjacency = new Map<GraphNodeKey, GraphAdjacencyEntry[]>();

  for (const node of nodes) {
    adjacency.set(node.key, []);
  }

  const links: GraphSceneLink[] = [];
  for (const edge of graph.edges) {
    const sourceKey = graphNodeKey(edge.source);
    const targetKey = graphNodeKey(edge.target);
    if (!nodeByKey.has(sourceKey) || !nodeByKey.has(targetKey)) continue;

    const link: GraphSceneLink = {
      edge,
      id: edge.id,
      source: sourceKey,
      sourceKey,
      target: targetKey,
      targetKey,
    };
    links.push(link);
    adjacency.get(sourceKey)!.push({ edgeId: edge.id, neighborKey: targetKey });
    adjacency.get(targetKey)!.push({ edgeId: edge.id, neighborKey: sourceKey });
  }

  return {
    adjacency,
    linkById: new Map(links.map((link) => [link.id, link])),
    links,
    nodeByKey,
    nodes,
  };
}

export function selectGraphNeighborhood(
  scene: GraphScene,
  rootKey: GraphNodeKey,
  requestedDepth: number,
): GraphNeighborhood {
  if (!scene.nodeByKey.has(rootKey)) {
    return { distances: new Map(), edgeIds: new Set(), nodeKeys: new Set() };
  }

  const depth = Math.max(1, Math.min(5, Math.trunc(requestedDepth)));
  const distances = new Map<GraphNodeKey, number>([[rootKey, 0]]);
  const queue: GraphNodeKey[] = [rootKey];

  for (let index = 0; index < queue.length; index += 1) {
    const currentKey = queue[index]!;
    const currentDistance = distances.get(currentKey)!;
    if (currentDistance >= depth) continue;

    for (const entry of scene.adjacency.get(currentKey) ?? []) {
      if (distances.has(entry.neighborKey)) continue;
      distances.set(entry.neighborKey, currentDistance + 1);
      queue.push(entry.neighborKey);
    }
  }

  const nodeKeys = new Set(distances.keys());
  const edgeIds = new Set(
    scene.links
      .filter(
        (link) =>
          nodeKeys.has(link.sourceKey) && nodeKeys.has(link.targetKey),
      )
      .map((link) => link.id),
  );

  return { distances, edgeIds, nodeKeys };
}

export function searchGraphNodes(
  scene: GraphScene,
  query: string,
  options: { excludeKey?: GraphNodeKey; limit?: number } = {},
): GraphSceneNode[] {
  const terms = query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const limit = Math.max(1, options.limit ?? 12);
  const results: GraphSceneNode[] = [];

  for (const node of scene.nodes) {
    if (node.key === options.excludeKey) continue;
    const searchable = graphNodeSearchText(node);
    if (terms.some((term) => !searchable.includes(term))) continue;
    results.push(node);
    if (results.length >= limit) break;
  }

  return results;
}
