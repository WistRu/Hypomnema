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
import { useI18n } from "./i18n";
import {
  handleMiddleClickClose,
  preventMiddleClickAutoscroll,
} from "./middle-click-close";

type GraphColorMode = "status" | "browser";
type FlowData = Record<string, unknown> & {
  label: ReactNode;
  tabId?: number;
};

interface GraphViewProps {
  closeErrorForTab: (tabId: number) => string | undefined;
  isClosingTab: (tabId: number) => boolean;
  onCloseTab: (tabId: number) => void;
  rootTag: string;
  onSelectTab: (tabId: number) => void;
}

const STATUS_COLORS: Record<GraphNode["status"], string> = {
  inbox: "#718cff",
  in_progress: "#d6ad62",
  done: "#58c98c",
  archived: "#78818e",
};

const BROWSER_LABELS: Record<string, string> = {
  chrome: "Chrome",
  edge: "Edge",
  yandex: "Yandex",
};

function browserLabel(browser: string, t: (key: string) => string): string {
  const normalized = browser.toLowerCase();
  return BROWSER_LABELS[normalized] ??
    (normalized === "other" ? t("Other") : browser);
}

const STATUS_LABELS: Record<GraphNode["status"], string> = {
  inbox: "inbox",
  in_progress: "in progress",
  done: "done",
  archived: "archived",
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

export function GraphNodeCard({
  browser,
  closeError,
  closeInProgress = false,
  closingLabel,
  groupKey,
  node,
  onMiddleClose,
  openLabel,
  statusLabel,
}: {
  browser: string;
  closeError?: string | undefined;
  closeInProgress?: boolean | undefined;
  closingLabel: string;
  groupKey: string;
  node: GraphNode;
  onMiddleClose: (tabId: number) => void;
  openLabel: string;
  statusLabel: string;
}) {
  return (
    <div
      className="graph-node-card"
      onAuxClick={(event) => {
        if (!node.isOpen) return;
        handleMiddleClickClose(event, () => onMiddleClose(node.id));
      }}
      onMouseDown={preventMiddleClickAutoscroll}
    >
      <div className="graph-node-title" title={displayTitle(node)}>
        {displayTitle(node)}
      </div>
      <div className="graph-node-meta">
        <span>{statusLabel}</span>
        <span>{browser}</span>
        <span>{closeInProgress ? closingLabel : openLabel}</span>
      </div>
      <div
        className="graph-node-topic"
        role={closeError ? "alert" : undefined}
        title={closeError ?? groupKey}
      >
        {closeError ?? groupKey}
      </div>
    </div>
  );
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

export default function GraphView({
  closeErrorForTab,
  isClosingTab,
  onCloseTab,
  rootTag,
  onSelectTab,
}: GraphViewProps) {
  const { errorMessage, formatNumber, t } = useI18n();
  const [colorMode, setColorMode] = useState<GraphColorMode>("status");
  const [branchRootId, setBranchRootId] = useState<number | null>(null);
  const graphQuery = useQuery({
    queryKey: ["graph", rootTag],
    queryFn: ({ signal }) => fetchGraph(rootTag, signal),
  });
  const graph = graphQuery.data;
  const layout = useMemo(
    () => layoutGraphNodes(graph?.nodes ?? [], rootTag, t),
    [graph?.nodes, rootTag, t],
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
            <span>{t("{count} tabs", {
              count: formatNumber(group.count),
              rawCount: group.count,
            })}</span>
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
      const statusLabel = t(STATUS_LABELS[node.status]);
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
            <GraphNodeCard
              browser={browserLabel(node.browser, t)}
              closeError={closeErrorForTab(node.id)}
              closeInProgress={isClosingTab(node.id)}
              closingLabel={t("Closing...")}
              groupKey={positioned.groupKey}
              node={node}
              onMiddleClose={onCloseTab}
              openLabel={node.isOpen ? t("open") : t("closed")}
              statusLabel={statusLabel}
            />
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
        ariaLabel: t("{title}, {status}, importance {importance}", {
          importance: formatNumber(node.importance),
          status: statusLabel,
          title: displayTitle(node),
        }),
      };
    });

    return [...groupNodes, ...tabNodes];
  }, [
    activeBranchRoot,
    closeErrorForTab,
    colorMode,
    formatNumber,
    isClosingTab,
    layout.groups,
    layout.nodes,
    onCloseTab,
    reachable,
    t,
  ]);

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
    <section className="graph-panel" aria-label={t("Tab knowledge graph")}>
      <header className="graph-toolbar">
        <div className="graph-metrics">
          <strong>{t("{count} nodes", {
            count: graph ? formatNumber(graph.nodes.length) : "-",
            rawCount: graph?.nodes.length ?? 0,
          })}</strong>
          <span>{t("{count} links", {
            count: graph ? formatNumber(graph.edges.length) : "-",
            rawCount: graph?.edges.length ?? 0,
          })}</span>
          <span>{t("{count} topic groups", {
            count: formatNumber(layout.groups.length),
            rawCount: layout.groups.length,
          })}</span>
        </div>
        <div className="graph-color-switch" aria-label={t("Graph color mode")} role="group">
          <span>{t("Color by")}</span>
          <button
            aria-pressed={colorMode === "status"}
            type="button"
            onClick={() => setColorMode("status")}
          >
            {t("Status")}
          </button>
          <button
            aria-pressed={colorMode === "browser"}
            type="button"
            onClick={() => setColorMode("browser")}
          >
            {t("Browser")}
          </button>
        </div>
        {activeBranchRoot !== null ? (
          <div className="branch-selection" role="status">
            <span>
              {t("Branch from {title} | {count} nodes", {
                count: formatNumber(reachable.size),
                rawCount: reachable.size,
                title: selectedRoot
                  ? displayTitle(selectedRoot)
                  : `#${formatNumber(activeBranchRoot)}`,
              })}
            </span>
            <button type="button" onClick={() => setBranchRootId(null)}>
              {t("Clear branch")}
            </button>
          </div>
        ) : (
          <p className="graph-hint">{t("Select a node to trace its outgoing follows branch.")}</p>
        )}
      </header>

      <div className="graph-canvas">
        {graphQuery.isPending ? (
          <GraphState title={t("Loading graph")} detail={t("Reading tabs, topics, and links...")} />
        ) : null}
        {graphQuery.isError ? (
          <GraphState
            title={t("Couldn't load graph")}
            detail={errorMessage(graphQuery.error)}
            action={
              <button type="button" onClick={() => void graphQuery.refetch()}>
                {t("Try again")}
              </button>
            }
          />
        ) : null}
        {graphQuery.isSuccess && graph?.nodes.length === 0 ? (
          <GraphState
            title={rootTag ? t("No tabs in this topic") : t("No graph nodes yet")}
            detail={
              rootTag
                ? t("Choose another topic or assign tabs to this branch.")
                : t("Capture tabs to start building the knowledge graph.")
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
