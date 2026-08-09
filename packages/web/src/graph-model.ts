import type { GraphNode, TabLink } from "@tabhub/shared";

export interface GraphNodeSize {
  height: number;
  width: number;
}

export interface PositionedGraphNode {
  groupKey: string;
  node: GraphNode;
  position: { x: number; y: number };
  size: GraphNodeSize;
}

export interface GraphLayoutGroup {
  count: number;
  height: number;
  id: string;
  label: string;
  width: number;
  x: number;
}

export interface GraphLayout {
  groups: GraphLayoutGroup[];
  height: number;
  nodes: PositionedGraphNode[];
  width: number;
}

export type GraphModelTranslator = (key: string) => string;

const horizontalCell = 214;
const verticalCell = 108;
const groupGap = 96;
const groupHeaderHeight = 46;

function compareText(left: string, right: string) {
  const normalizedLeft = left.toLocaleLowerCase("en-US");
  const normalizedRight = right.toLocaleLowerCase("en-US");
  if (normalizedLeft < normalizedRight) return -1;
  if (normalizedLeft > normalizedRight) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function nodeGroup(
  node: GraphNode,
  selectedRoot: string,
  t: GraphModelTranslator | undefined,
) {
  if (selectedRoot) {
    return {
      id: `selected:${selectedRoot}`,
      label: selectedRoot,
      sortLabel: selectedRoot,
    };
  }
  const rootTag = node.rootTags[0];
  return rootTag
    ? { id: `tag:${rootTag}`, label: rootTag, sortLabel: rootTag }
    : {
        id: "untagged",
        label: t?.("Untagged") ?? "Untagged",
        sortLabel: "Untagged",
      };
}

export function graphNodeSize(importance: GraphNode["importance"]): GraphNodeSize {
  return {
    width: 150 + importance * 12,
    height: 56 + importance * 4,
  };
}

export function layoutGraphNodes(
  nodes: GraphNode[],
  selectedRoot = "",
  t?: GraphModelTranslator,
): GraphLayout {
  const grouped = new Map<
    string,
    { label: string; nodes: GraphNode[]; sortLabel: string }
  >();
  for (const node of nodes) {
    const identity = nodeGroup(node, selectedRoot, t);
    const group = grouped.get(identity.id) ?? {
      label: identity.label,
      nodes: [],
      sortLabel: identity.sortLabel,
    };
    group.nodes.push(node);
    grouped.set(identity.id, group);
  }

  const groupEntries = [...grouped.entries()].sort((left, right) => {
    const labelOrder = compareText(left[1].sortLabel, right[1].sortLabel);
    return labelOrder || compareText(left[0], right[0]);
  });
  const positioned: PositionedGraphNode[] = [];
  const groups: GraphLayoutGroup[] = [];
  let nextGroupX = 0;
  let maximumHeight = 0;

  for (const [id, group] of groupEntries) {
    const groupNodes = group.nodes;
    groupNodes.sort((left, right) => {
      const titleOrder = compareText(left.title ?? left.url, right.title ?? right.url);
      return titleOrder || left.id - right.id;
    });
    const columns = Math.min(
      12,
      Math.max(1, Math.ceil(Math.sqrt(groupNodes.length * 1.8))),
    );
    const rows = Math.ceil(groupNodes.length / columns);
    const width = columns * horizontalCell - 24;
    const height = groupHeaderHeight + rows * verticalCell;

    groups.push({
      count: groupNodes.length,
      height,
      id,
      label: group.label,
      width,
      x: nextGroupX,
    });
    maximumHeight = Math.max(maximumHeight, height);

    groupNodes.forEach((node, index) => {
      positioned.push({
        groupKey: group.label,
        node,
        position: {
          x: nextGroupX + (index % columns) * horizontalCell,
          y: groupHeaderHeight + Math.floor(index / columns) * verticalCell,
        },
        size: graphNodeSize(node.importance),
      });
    });
    nextGroupX += width + groupGap;
  }

  return {
    groups,
    height: maximumHeight,
    nodes: positioned,
    width: Math.max(0, nextGroupX - groupGap),
  };
}

export function reachableFollowsBranch(
  rootId: number,
  edges: TabLink[],
  visibleNodeIds: Iterable<number>,
) {
  const visible = new Set(visibleNodeIds);
  if (!visible.has(rootId)) return new Set<number>();

  const outgoing = new Map<number, number[]>();
  for (const edge of edges) {
    if (
      edge.kind !== "follows" ||
      !visible.has(edge.fromTab) ||
      !visible.has(edge.toTab)
    ) {
      continue;
    }
    const targets = outgoing.get(edge.fromTab) ?? [];
    targets.push(edge.toTab);
    outgoing.set(edge.fromTab, targets);
  }

  const reachable = new Set<number>([rootId]);
  const queue = [rootId];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    for (const target of outgoing.get(current) ?? []) {
      if (reachable.has(target)) continue;
      reachable.add(target);
      queue.push(target);
    }
  }

  return reachable;
}
