import type { GraphNode } from "@tabhub/shared";
import { useQuery } from "@tanstack/react-query";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  Position,
  ReactFlow,
  type Edge as FlowEdge,
  type Node as FlowNode,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from "react";

import { fetchGraph } from "./api";
import { layoutGraphNodes, reachableFollowsBranch } from "./graph-model";

type GraphColorMode = "status" | "browser";
type FlowData = Record<string, unknown> & {
  label: ReactNode;
  tabId?: number;
};

interface GraphViewProps {
  rootTag: string;
  onSelectTab: (tabId: number) => void;
}

const STATUS_COLORS: Record<GraphNode["status"], string> = {
  inbox: "#718cff",
  in_progress: "#d6ad62",
  done: "#58c98c",
  archived: "#78818e",
};

const BROWSER_COLORS: Record<string, string> = {
  chrome: "#58b47f",
  edge: "#4ba6d8",
  other: "#9b83d8",
  yandex: "#dc5a67",
};

function browserColor(browser: string) {
  const known = BROWSER_COLORS[browser.toLocaleLowerCase("en-US")];
  if (known) return known;

  let hash = 0;
  for (const character of browser) {
    hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  }
  return `hsl(${hash % 360} 48% 58%)`;
}

function nodeAccent(node: GraphNode, mode: GraphColorMode) {
  return mode === "status" ? STATUS_COLORS[node.status] : browserColor(node.browser);
}

function displayTitle(node: GraphNode) {
  if (node.title?.trim()) return node.title.trim();
  try {
    return new URL(node.url).hostname;
  } catch {
    return node.url;
  }
}

function GraphState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="graph-state">
      <div className="graph-state-mark" aria-hidden="true" />
      <strong>{title}</strong>
      <span>{detail}</span>
      {action}
    </div>
  );
}

export default function GraphView({ rootTag, onSelectTab }: GraphViewProps) {
  const [colorMode, setColorMode] = useState<GraphColorMode>("status");
  const [branchRootId, setBranchRootId] = useState<number | null>(null);
  const graphQuery = useQuery({
    queryKey: ["graph", rootTag],
    queryFn: ({ signal }) => fetchGraph(rootTag, signal),
  });
  const graph = graphQuery.data;
  const layout = useMemo(
    () => layoutGraphNodes(graph?.nodes ?? [], rootTag),
    [graph?.nodes, rootTag],
  );
  const visibleIds = useMemo(
    () => new Set((graph?.nodes ?? []).map((node) => node.id)),
    [graph?.nodes],
  );
  const activeBranchRoot =
    branchRootId !== null && visibleIds.has(branchRootId) ? branchRootId : null;
  const reachable = useMemo(
    () =>
      activeBranchRoot === null
        ? new Set<number>()
        : reachableFollowsBranch(
            activeBranchRoot,
            graph?.edges ?? [],
            visibleIds,
          ),
    [activeBranchRoot, graph?.edges, visibleIds],
  );

  useEffect(() => {
    if (branchRootId !== null && !visibleIds.has(branchRootId)) {
      setBranchRootId(null);
    }
  }, [branchRootId, visibleIds]);

  const flowNodes = useMemo(() => {
    const groupNodes: FlowNode<FlowData>[] = layout.groups.map((group) => ({
      id: `group:${group.id}`,
      data: {
        label: (
          <div className="graph-group-label">
            <strong>{group.label}</strong>
            <span>{group.count.toLocaleString()} tabs</span>
          </div>
        ),
      },
      position: { x: group.x, y: 0 },
      draggable: false,
      selectable: false,
      connectable: false,
      focusable: false,
      className: "graph-group-node",
      style: { height: 34, width: group.width },
    }));
    const tabNodes: FlowNode<FlowData>[] = layout.nodes.map((positioned) => {
      const node = positioned.node;
      const accent = nodeAccent(node, colorMode);
      const branchActive = activeBranchRoot !== null;
      const inBranch = reachable.has(node.id);
      const classNames = [
        "graph-tab-node",
        branchActive && !inBranch ? "is-dimmed" : "",
        inBranch ? "is-branch" : "",
        activeBranchRoot === node.id ? "is-branch-root" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const style = {
        "--graph-accent": accent,
        height: positioned.size.height,
        width: positioned.size.width,
      } as CSSProperties;

      return {
        id: String(node.id),
        data: {
          tabId: node.id,
          label: (
            <div className="graph-node-card">
              <div className="graph-node-title" title={displayTitle(node)}>
                {displayTitle(node)}
              </div>
              <div className="graph-node-meta">
                <span>{node.status.replace("_", " ")}</span>
                <span>{node.browser}</span>
                <span>{node.isOpen ? "open" : "closed"}</span>
              </div>
              <div className="graph-node-topic" title={positioned.groupKey}>
                {positioned.groupKey}
              </div>
            </div>
          ),
        },
        position: positioned.position,
        width: positioned.size.width,
        height: positioned.size.height,
        draggable: false,
        connectable: false,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        className: classNames,
        style,
        ariaLabel: `${displayTitle(node)}, ${node.status.replace("_", " ")}, importance ${node.importance}`,
      };
    });

    return [...groupNodes, ...tabNodes];
  }, [activeBranchRoot, colorMode, layout.groups, layout.nodes, reachable]);

  const flowEdges = useMemo<FlowEdge[]>(() => {
    const branchActive = activeBranchRoot !== null;
    return (graph?.edges ?? []).map((edge) => {
      const relevant =
        branchActive &&
        edge.kind === "follows" &&
        reachable.has(edge.fromTab) &&
        reachable.has(edge.toTab);
      const color = relevant ? "#8fa3ff" : "#4b5668";
      return {
        id: String(edge.id),
        source: String(edge.fromTab),
        target: String(edge.toTab),
        label: relevant || (graph?.edges.length ?? 0) <= 80 ? edge.kind : undefined,
        className: [
          "graph-edge",
          relevant ? "is-branch" : "",
          branchActive && !relevant ? "is-dimmed" : "",
        ]
          .filter(Boolean)
          .join(" "),
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 13, height: 13 },
        style: {
          stroke: color,
          strokeWidth: relevant ? 2.2 : 1.1,
          opacity: branchActive && !relevant ? 0.12 : 0.72,
        },
        labelStyle: {
          fill: relevant ? "#bec9ff" : "#788494",
          fontSize: 8,
          fontWeight: 650,
        },
        labelBgStyle: { fill: "#0e1219", fillOpacity: 0.9 },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 3,
      };
    });
  }, [activeBranchRoot, graph?.edges, reachable]);

  const selectedRoot = graph?.nodes.find((node) => node.id === activeBranchRoot);

  return (
    <section className="graph-panel" aria-label="Tab knowledge graph">
      <header className="graph-toolbar">
        <div className="graph-metrics">
          <strong>{graph?.nodes.length.toLocaleString() ?? "-"} nodes</strong>
          <span>{graph?.edges.length.toLocaleString() ?? "-"} links</span>
          <span>{layout.groups.length.toLocaleString()} topic groups</span>
        </div>
        <div className="graph-color-switch" aria-label="Graph color mode" role="group">
          <span>Color by</span>
          <button
            aria-pressed={colorMode === "status"}
            type="button"
            onClick={() => setColorMode("status")}
          >
            Status
          </button>
          <button
            aria-pressed={colorMode === "browser"}
            type="button"
            onClick={() => setColorMode("browser")}
          >
            Browser
          </button>
        </div>
        {activeBranchRoot !== null ? (
          <div className="branch-selection" role="status">
            <span>
              Branch from {selectedRoot ? displayTitle(selectedRoot) : `#${activeBranchRoot}`}
              {" | "}
              {reachable.size.toLocaleString()} nodes
            </span>
            <button type="button" onClick={() => setBranchRootId(null)}>
              Clear branch
            </button>
          </div>
        ) : (
          <p className="graph-hint">Select a node to trace its outgoing follows branch.</p>
        )}
      </header>

      <div className="graph-canvas">
        {graphQuery.isPending ? (
          <GraphState title="Loading graph" detail="Reading tabs, topics, and links..." />
        ) : null}
        {graphQuery.isError ? (
          <GraphState
            title="Couldn't load graph"
            detail={graphQuery.error.message}
            action={
              <button type="button" onClick={() => void graphQuery.refetch()}>
                Try again
              </button>
            }
          />
        ) : null}
        {graphQuery.isSuccess && graph?.nodes.length === 0 ? (
          <GraphState
            title={rootTag ? "No tabs in this topic" : "No graph nodes yet"}
            detail={
              rootTag
                ? "Choose another topic or assign tabs to this branch."
                : "Capture tabs to start building the knowledge graph."
            }
          />
        ) : null}
        {graphQuery.isSuccess && graph && graph.nodes.length > 0 ? (
          <ReactFlow
            key={rootTag || "all-topics"}
            colorMode="dark"
            edges={flowEdges}
            fitView
            fitViewOptions={{ maxZoom: 1, padding: 0.16 }}
            maxZoom={1.8}
            minZoom={0.06}
            nodes={flowNodes}
            nodesConnectable={false}
            nodesDraggable={false}
            onlyRenderVisibleElements
            onNodeClick={(_event, node) => {
              const tabId = node.data.tabId;
              if (typeof tabId !== "number") return;
              setBranchRootId(tabId);
              onSelectTab(tabId);
            }}
          >
            <Background color="#27303d" gap={22} size={1} variant={BackgroundVariant.Dots} />
            <Controls position="bottom-right" showInteractive={false} />
          </ReactFlow>
        ) : null}
      </div>
    </section>
  );
}
