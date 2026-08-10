import type {
  GraphV2Node,
} from "@tabhub/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ForceGraph3D, {
  type ForceGraphMethods,
  type NodeObject,
} from "react-force-graph-3d";
import {
  Component,
  type ErrorInfo,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import * as THREE from "three";

import {
  createRelation,
  deleteRelation,
  fetchKnowledgeGraph,
} from "./api";
import { InitialGraphAutoFit } from "./graph-camera";
import {
  buildGraphScene,
  graphNodeRef,
  graphNodeRefFromKey,
  middleClickTabId,
  selectGraphProjection,
  selectGraphNeighborhood,
  type GraphNodeKey,
  type GraphSceneLink,
  type GraphSceneNode,
} from "./graph-model";
import { useI18n, type TranslationParams } from "./i18n";
import type { CanonicalTabBrowserActionRequest } from "./open-tab-activation";
import { TabBrowserAction } from "./TabBrowserAction";
import type { SelectedTopic } from "./TopicSidebar";
import "./graph-view.css";

interface GraphViewProps {
  activationErrorForTab: (tabId: number) => string | undefined;
  activationInProgress: boolean;
  closeErrorForTab: (tabId: number) => string | undefined;
  isActivatingTab: (tabId: number) => boolean;
  isClosingTab: (tabId: number) => boolean;
  rootTag: string;
  rootTopicId: number | null;
  onBrowserAction: (request: CanonicalTabBrowserActionRequest) => void;
  onCloseTab: (tabId: number) => void;
  onSelectTab: (tabId: number) => void;
  onSelectTopic: (topic: SelectedTopic | null) => void;
}

interface CanvasSize {
  height: number;
  width: number;
}

type GraphRef = ForceGraphMethods<GraphSceneNode, GraphSceneLink>;
type GraphNodeMesh = THREE.Mesh<
  THREE.BufferGeometry,
  THREE.MeshLambertMaterial
>;

const STATUS_COLORS: Record<
  Extract<GraphV2Node, { type: "tab" }>["status"],
  string
> = {
  inbox: "#6f86ff",
  in_progress: "#e7b85f",
  done: "#54d69a",
  archived: "#727d8d",
};

const EDGE_COLORS = {
  containment: "#987dff",
  membership: "#4b9bd5",
  relation: "#f2c46f",
} as const;

const TAB_GEOMETRY = new THREE.IcosahedronGeometry(4.2, 1);
const TAB_GEOMETRY_DENSE = new THREE.IcosahedronGeometry(4.2, 0);
const TOPIC_GEOMETRY = new THREE.OctahedronGeometry(6.1, 0);
const KNOWLEDGE_GRAPH_QUERY_KEY = ["graph", "knowledge"] as const;

function displayTitle(node: GraphSceneNode): string {
  if (node.type === "topic") return node.name;
  if (node.title?.trim()) return node.title.trim();
  try {
    return new URL(node.url).hostname;
  } catch {
    return node.url;
  }
}

function nodeColor(node: GraphSceneNode): string {
  if (node.type === "tab") return STATUS_COLORS[node.status];
  return /^#[\da-f]{3,8}$/i.test(node.color ?? "")
    ? node.color!
    : "#a388ff";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#039;";
    }
  });
}

function nodeTypeLabel(
  node: GraphSceneNode,
  t: (key: string, params?: TranslationParams) => string,
): string {
  return node.type === "topic" ? t("Topic node") : t("Tab node");
}

function GraphState({
  action,
  detail,
  title,
}: {
  action?: ReactNode;
  detail: string;
  title: string;
}) {
  return (
    <div className="graph-3d-state">
      <div className="graph-3d-state-mark" aria-hidden="true" />
      <strong>{title}</strong>
      <span>{detail}</span>
      {action}
    </div>
  );
}

class GraphRendererBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(_error: unknown, _info: ErrorInfo) {
    // The accessible fallback below remains usable when WebGL is unavailable.
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function useCanvasSize() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<CanvasSize>({ height: 680, width: 900 });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const update = () => {
      const bounds = host.getBoundingClientRect();
      setSize({
        height: Math.max(420, Math.round(bounds.height)),
        width: Math.max(320, Math.round(bounds.width)),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  return { hostRef, size };
}

function RelationComposer({
  sceneNodes,
  selectedNode,
  onCreated,
}: {
  sceneNodes: GraphSceneNode[];
  selectedNode: GraphSceneNode;
  onCreated: () => void;
}) {
  const { errorMessage, t } = useI18n();
  const [query, setQuery] = useState("");
  const [targetKey, setTargetKey] = useState<GraphNodeKey | null>(null);
  const [direction, setDirection] = useState<"outgoing" | "incoming">(
    "outgoing",
  );
  const [kind, setKind] = useState("related");
  const [note, setNote] = useState("");
  const kindListId = useId();
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const candidates = useMemo(
    () =>
      sceneNodes
        .filter((node) => node.key !== selectedNode.key)
        .filter((node) => {
          if (!normalizedQuery) return false;
          const haystack = [
            displayTitle(node),
            node.key,
            node.type === "topic" ? node.path : node.url,
          ]
            .join(" ")
            .toLocaleLowerCase();
          return haystack.includes(normalizedQuery);
        })
        .slice(0, 12),
    [normalizedQuery, sceneNodes, selectedNode.key],
  );
  const target = targetKey
    ? sceneNodes.find((node) => node.key === targetKey) ?? null
    : null;
  const mutation = useMutation({
    mutationFn: () => {
      if (!target) throw new Error(t("Choose a relation target."));
      const selectedRef = graphNodeRef(selectedNode);
      const targetRef = graphNodeRef(target);
      return createRelation({
        from: direction === "outgoing" ? selectedRef : targetRef,
        to: direction === "outgoing" ? targetRef : selectedRef,
        kind: kind.trim(),
        note: note.trim() || undefined,
        createdBy: "user",
      });
    },
    onSuccess: () => {
      setQuery("");
      setTargetKey(null);
      setKind("related");
      setNote("");
      onCreated();
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (target && kind.trim()) mutation.mutate();
  };

  return (
    <form className="graph-relation-composer" onSubmit={submit}>
      <div className="graph-inspector-section-heading">
        <strong>{t("Create relation")}</strong>
      </div>
      <label>
        <span>{t("Find a tab or topic")}</span>
        <input
          autoComplete="off"
          disabled={mutation.isPending}
          placeholder={t("Search by title, URL, or topic")}
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setTargetKey(null);
          }}
        />
      </label>
      {candidates.length > 0 && target === null ? (
        <ul className="graph-relation-results">
          {candidates.map((candidate) => (
            <li key={candidate.key}>
              <button
                type="button"
                onClick={() => {
                  setTargetKey(candidate.key);
                  setQuery(displayTitle(candidate));
                }}
              >
                <span className={`graph-node-kind is-${candidate.type}`}>
                  {candidate.type === "topic" ? t("Topic") : t("Tab")}
                </span>
                <strong>{displayTitle(candidate)}</strong>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {target ? (
        <div className="graph-relation-target">
          <span>{nodeTypeLabel(target, t)}</span>
          <strong>{displayTitle(target)}</strong>
          <button
            aria-label={t("Clear relation target")}
            type="button"
            onClick={() => {
              setQuery("");
              setTargetKey(null);
            }}
          >
            ×
          </button>
        </div>
      ) : null}
      <label>
        <span>{t("Direction")}</span>
        <select
          disabled={mutation.isPending}
          value={direction}
          onChange={(event) =>
            setDirection(event.target.value as "outgoing" | "incoming")
          }
        >
          <option value="outgoing">{t("Selected node → target")}</option>
          <option value="incoming">{t("Target → selected node")}</option>
        </select>
      </label>
      <label>
        <span>{t("Relation kind")}</span>
        <input
          disabled={mutation.isPending}
          list={kindListId}
          maxLength={128}
          required
          value={kind}
          onChange={(event) => setKind(event.target.value)}
        />
        <datalist id={kindListId}>
          <option value="related" />
          <option value="supports" />
          <option value="contradicts" />
          <option value="follows" />
          <option value="references" />
        </datalist>
      </label>
      <label>
        <span>{t("Note")}</span>
        <textarea
          disabled={mutation.isPending}
          maxLength={10_000}
          placeholder={t("Why are these nodes connected?")}
          rows={2}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <button
        className="graph-primary-button"
        disabled={mutation.isPending || !target || !kind.trim()}
        type="submit"
      >
        {mutation.isPending ? t("Creating relation...") : t("Create relation")}
      </button>
      {mutation.isError ? (
        <p className="graph-inline-error" role="alert">
          {errorMessage(mutation.error)}
        </p>
      ) : null}
    </form>
  );
}

function NodeInspector({
  activationErrorForTab,
  activationInProgress,
  connectedLinks,
  deleteError,
  deletingRelationId,
  isActivatingTab,
  isClosingTab,
  node,
  sceneNodes,
  onBrowserAction,
  onCloseTab,
  onDeleteRelation,
  onOpenNode,
  onRelationCreated,
  onSelectNode,
}: {
  activationErrorForTab: (tabId: number) => string | undefined;
  activationInProgress: boolean;
  connectedLinks: GraphSceneLink[];
  deleteError: unknown;
  deletingRelationId: number | null;
  isActivatingTab: (tabId: number) => boolean;
  isClosingTab: (tabId: number) => boolean;
  node: GraphSceneNode | null;
  sceneNodes: GraphSceneNode[];
  onBrowserAction: (request: CanonicalTabBrowserActionRequest) => void;
  onCloseTab: (tabId: number) => void;
  onDeleteRelation: (id: number) => void;
  onOpenNode: (node: GraphSceneNode) => void;
  onRelationCreated: () => void;
  onSelectNode: (key: GraphNodeKey) => void;
}) {
  const { errorMessage, formatNumber, t } = useI18n();

  if (!node) {
    return (
      <aside className="graph-inspector is-empty" aria-label={t("Node details")}>
        <div className="graph-inspector-empty-mark" aria-hidden="true" />
        <strong>{t("Select a node")}</strong>
        <p>{t("Choose any tab or topic in the 3D space to inspect its details and connections.")}</p>
      </aside>
    );
  }

  return (
    <aside className="graph-inspector" aria-label={t("Node details")}>
      <div className="graph-inspector-header">
        <span className={`graph-node-kind is-${node.type}`}>
          {nodeTypeLabel(node, t)}
        </span>
        <h3>{displayTitle(node)}</h3>
        <code>{node.key}</code>
      </div>

      {node.type === "tab" ? (
        <div className="graph-inspector-summary">
          <p className="graph-tab-url" title={node.url}>
            {node.url}
          </p>
          <dl>
            <div>
              <dt>{t("Browser")}</dt>
              <dd>{node.browser}</dd>
            </div>
            <div>
              <dt>{t("Status")}</dt>
              <dd>{t(node.status === "in_progress" ? "in progress" : node.status)}</dd>
            </div>
            <div>
              <dt>{t("Topics")}</dt>
              <dd>
                {node.tagPaths.length
                  ? node.tagPaths.join(", ")
                  : t("No topics assigned.")}
              </dd>
            </div>
          </dl>
          <div className="graph-inspector-actions">
            <TabBrowserAction
              activationError={activationErrorForTab(node.id)}
              activationInProgress={activationInProgress}
              closeInProgress={isClosingTab(node.id)}
              isActivating={isActivatingTab(node.id)}
              tab={node}
              onBrowserAction={onBrowserAction}
              onMiddleClose={onCloseTab}
            />
            <button type="button" onClick={() => onOpenNode(node)}>
              {t("Open tab details")}
            </button>
          </div>
        </div>
      ) : (
        <div className="graph-inspector-summary">
          <p>{node.path}</p>
          <dl>
            <div>
              <dt>{t("Direct tabs")}</dt>
              <dd>{formatNumber(node.directTabCount)}</dd>
            </div>
            <div>
              <dt>{t("Tabs in subtree")}</dt>
              <dd>{formatNumber(node.tabCount)}</dd>
            </div>
          </dl>
          <div className="graph-inspector-actions">
            <button
              className="graph-primary-button"
              type="button"
              onClick={() => onOpenNode(node)}
            >
              {t("Open topic in Library")}
            </button>
          </div>
        </div>
      )}

      <section className="graph-connected-list">
        <div className="graph-inspector-section-heading">
          <strong>{t("Connections")}</strong>
          <span>{formatNumber(connectedLinks.length)}</span>
        </div>
        {connectedLinks.length > 0 ? (
          <ul>
            {connectedLinks.map((link) => {
              const outgoing = link.sourceKey === node.key;
              const neighborKey = outgoing ? link.targetKey : link.sourceKey;
              const neighbor = sceneNodes.find(
                (candidate) => candidate.key === neighborKey,
              );
              if (!neighbor) return null;
              return (
                <li key={link.id}>
                  <button
                    className="graph-connected-node"
                    type="button"
                    onClick={() => onSelectNode(neighbor.key)}
                  >
                    <span>{outgoing ? "→" : "←"}</span>
                    <strong>{displayTitle(neighbor)}</strong>
                    <small>
                      {link.edge.edgeType === "relation"
                        ? link.edge.relationKind
                        : t(link.edge.edgeType)}
                    </small>
                  </button>
                  {link.edge.relationId !== null ? (
                    <button
                      aria-label={t("Delete relation to {node}", {
                        node: displayTitle(neighbor),
                      })}
                      className="graph-delete-relation"
                      disabled={deletingRelationId === link.edge.relationId}
                      title={t("Delete relation")}
                      type="button"
                      onClick={() => onDeleteRelation(link.edge.relationId!)}
                    >
                      ×
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p>{t("No relations yet.")}</p>
        )}
        {deleteError ? (
          <p className="graph-inline-error" role="alert">
            {errorMessage(deleteError)}
          </p>
        ) : null}
      </section>

      <RelationComposer
        key={node.key}
        sceneNodes={sceneNodes}
        selectedNode={node}
        onCreated={onRelationCreated}
      />
    </aside>
  );
}

export default function GraphView({
  activationErrorForTab,
  activationInProgress,
  closeErrorForTab,
  isActivatingTab,
  isClosingTab,
  rootTag,
  rootTopicId,
  onBrowserAction,
  onCloseTab,
  onSelectTab,
  onSelectTopic,
}: GraphViewProps) {
  const queryClient = useQueryClient();
  const { errorMessage, formatNumber, t } = useI18n();
  const graphRef = useRef<GraphRef | undefined>(undefined);
  const initialAutoFitRef = useRef(new InitialGraphAutoFit());
  const hoveredNodeRef = useRef<GraphSceneNode | null>(null);
  const nodeObjectCacheRef = useRef<Map<GraphNodeKey, GraphNodeMesh>>(
    new Map(),
  );
  const { hostRef, size } = useCanvasSize();
  const [selectedKey, setSelectedKey] = useState<GraphNodeKey | null>(null);
  const [focusDepth, setFocusDepth] = useState(1);
  const graphQuery = useQuery({
    queryKey: [...KNOWLEDGE_GRAPH_QUERY_KEY, rootTopicId],
    queryFn: ({ signal }) => fetchKnowledgeGraph(rootTopicId, signal),
  });
  const focusRequest = useMemo(
    () =>
      rootTopicId !== null && selectedKey !== null
        ? {
            depth: focusDepth,
            node: graphNodeRefFromKey(selectedKey),
          }
        : null,
    [focusDepth, rootTopicId, selectedKey],
  );
  const focusQuery = useQuery({
    queryKey: [
      ...KNOWLEDGE_GRAPH_QUERY_KEY,
      rootTopicId,
      "focus",
      selectedKey,
      focusDepth,
    ],
    queryFn: ({ signal }) => {
      if (focusRequest === null) {
        throw new Error("A graph focus request requires a selected node.");
      }
      return fetchKnowledgeGraph(rootTopicId, signal, focusRequest);
    },
    enabled: focusRequest !== null,
    gcTime: 30_000,
  });
  const scene = useMemo(
    () =>
      buildGraphScene(
        selectGraphProjection(
          graphQuery.data,
          focusQuery.data,
          focusRequest !== null,
        ),
      ),
    [focusQuery.data, focusRequest, graphQuery.data],
  );
  const selectedNode = selectedKey ? scene.nodeByKey.get(selectedKey) ?? null : null;
  const neighborhood = useMemo(
    () =>
      selectedKey
        ? selectGraphNeighborhood(scene, selectedKey, focusDepth)
        : null,
    [focusDepth, scene, selectedKey],
  );
  const connectedLinks = useMemo(
    () =>
      selectedNode
        ? scene.links.filter(
            (link) =>
              link.sourceKey === selectedNode.key ||
              link.targetKey === selectedNode.key,
          )
        : [],
    [scene.links, selectedNode],
  );
  const invalidateRelationViews = useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: KNOWLEDGE_GRAPH_QUERY_KEY,
        }),
        queryClient.invalidateQueries({ queryKey: ["links"] }),
        queryClient.invalidateQueries({ queryKey: ["tab"] }),
      ]),
    [queryClient],
  );
  const deleteMutation = useMutation({
    mutationFn: deleteRelation,
    onSuccess: invalidateRelationViews,
  });
  const topicCount = scene.nodes.filter((node) => node.type === "topic").length;
  const highDensity = scene.nodes.length > 1_000;

  useEffect(() => {
    setSelectedKey(null);
    hoveredNodeRef.current = null;
    initialAutoFitRef.current = new InitialGraphAutoFit();
  }, [rootTopicId]);

  useEffect(() => {
    if (selectedKey !== null && !scene.nodeByKey.has(selectedKey)) {
      setSelectedKey(null);
    }
  }, [scene.nodeByKey, selectedKey]);

  useEffect(() => {
    const cache = nodeObjectCacheRef.current;
    for (const [key, mesh] of cache) {
      if (scene.nodeByKey.has(key)) continue;
      mesh.material.dispose();
      cache.delete(key);
    }
  }, [scene.nodeByKey]);

  useEffect(
    () => () => {
      for (const mesh of nodeObjectCacheRef.current.values()) {
        mesh.material.dispose();
      }
      nodeObjectCacheRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedKey(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const renderer = graphRef.current?.renderer();
    if (!renderer) return;
    renderer.setPixelRatio(
      highDensity ? 1 : Math.min(2, window.devicePixelRatio || 1),
    );
  }, [graphQuery.isSuccess, highDensity]);

  const focusCamera = useCallback((node: GraphSceneNode) => {
    const positioned = node as NodeObject<GraphSceneNode>;
    if (
      positioned.x === undefined ||
      positioned.y === undefined ||
      positioned.z === undefined
    ) {
      return;
    }
    const distance = Math.hypot(positioned.x, positioned.y, positioned.z);
    const ratio = distance === 0 ? 1 : 1 + 95 / distance;
    graphRef.current?.cameraPosition(
      {
        x: positioned.x * ratio,
        y: positioned.y * ratio,
        z: positioned.z * ratio,
      },
      { x: positioned.x, y: positioned.y, z: positioned.z },
      650,
    );
  }, []);

  const selectNode = useCallback(
    (key: GraphNodeKey) => {
      const node = scene.nodeByKey.get(key);
      if (!node) return;
      setSelectedKey(key);
      focusCamera(node);
    },
    [focusCamera, scene.nodeByKey],
  );

  useEffect(() => {
    if (!neighborhood || !selectedNode) return;
    const timer = window.setTimeout(() => {
      if (neighborhood.nodeKeys.size <= 1) {
        focusCamera(selectedNode);
      } else {
        graphRef.current?.zoomToFit(
          550,
          90,
          (node) => neighborhood.nodeKeys.has(node.key),
        );
      }
    }, 80);
    return () => window.clearTimeout(timer);
  }, [focusCamera, neighborhood, selectedNode]);

  const makeNodeObject = useCallback(
    (node: GraphSceneNode) => {
      const active = neighborhood === null || neighborhood.nodeKeys.has(node.key);
      const selected = selectedKey === node.key;
      const color = nodeColor(node);
      const geometry =
        node.type === "topic"
          ? TOPIC_GEOMETRY
          : highDensity
            ? TAB_GEOMETRY_DENSE
            : TAB_GEOMETRY;
      let mesh = nodeObjectCacheRef.current.get(node.key);
      if (!mesh) {
        mesh = new THREE.Mesh(
          geometry,
          new THREE.MeshLambertMaterial({ transparent: true }),
        );
        nodeObjectCacheRef.current.set(node.key, mesh);
      }
      mesh.geometry = geometry;
      mesh.material.color.set(color);
      mesh.material.emissive.set(selected ? color : "#05070b");
      mesh.material.emissiveIntensity = selected ? 0.58 : 0.08;
      mesh.material.opacity = selected ? 1 : active ? 0.88 : 0.075;
      mesh.material.depthWrite = active;
      const scale =
        node.type === "topic"
          ? 1 + Math.min(0.7, Math.log2(node.tabCount + 1) * 0.08)
          : 0.9 + node.importance * 0.14;
      mesh.scale.setScalar(selected ? scale * 1.24 : scale);
      mesh.renderOrder = selected ? 3 : active ? 2 : 0;
      return mesh;
    },
    [highDensity, neighborhood, selectedKey],
  );

  const openNode = (node: GraphSceneNode) => {
    if (node.type === "tab") {
      onSelectTab(node.id);
    } else {
      onSelectTopic({ id: node.id, path: node.path });
    }
  };
  const refreshGraph = () => void invalidateRelationViews();
  const preventHoveredTabMiddleMouse = (
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    if (middleClickTabId(hoveredNodeRef.current, event.button) !== null) {
      event.preventDefault();
    }
  };
  const closeHoveredTabOnMiddleMouse = (
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    const tabId = middleClickTabId(hoveredNodeRef.current, event.button);
    if (tabId === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (!isClosingTab(tabId)) onCloseTab(tabId);
  };

  return (
    <section className="graph-panel graph-3d-panel" aria-label={t("3D knowledge graph")}>
      <header className="graph-3d-toolbar">
        <div className="graph-3d-metrics">
          <strong>
            {t("{count} nodes", {
              count: formatNumber(scene.nodes.length),
              rawCount: scene.nodes.length,
            })}
          </strong>
          <span>
            {t("{count} links", {
              count: formatNumber(scene.links.length),
              rawCount: scene.links.length,
            })}
          </span>
          <span>
            {t("{count} topics", {
              count: formatNumber(topicCount),
              rawCount: topicCount,
            })}
          </span>
        </div>
        <p className="graph-3d-navigation-hint">
          {t("Drag to rotate, right-drag to pan, and scroll to zoom.")}
        </p>
        <div className="graph-depth-control" role="group" aria-label={t("Focus depth")}>
          <span>{t("Focus depth")}</span>
          {[1, 2, 3, 4, 5].map((depth) => (
            <button
              aria-pressed={focusDepth === depth}
              disabled={!selectedNode}
              key={depth}
              type="button"
              onClick={() => setFocusDepth(depth)}
            >
              {depth}
            </button>
          ))}
        </div>
        {selectedNode ? (
          <div className="graph-focus-status" role="status">
            <span>
              {t("{count} nodes in focus", {
                count: formatNumber(neighborhood?.nodeKeys.size ?? 1),
                rawCount: neighborhood?.nodeKeys.size ?? 1,
              })}
            </span>
            <button type="button" onClick={() => setSelectedKey(null)}>
              {t("Clear selection")}
            </button>
          </div>
        ) : null}
        {focusQuery.isFetching ? (
          <span className="graph-focus-query-state" role="status">
            {t("Loading neighborhood...")}
          </span>
        ) : null}
        {focusQuery.isError ? (
          <span
            className="graph-focus-query-state is-error"
            role="alert"
            title={errorMessage(focusQuery.error)}
          >
            {t("Couldn't load the full neighborhood.")}
          </span>
        ) : null}
      </header>

      <div className="graph-3d-workspace">
        <div
          className="graph-3d-canvas"
          ref={hostRef}
          onAuxClick={closeHoveredTabOnMiddleMouse}
          onMouseDown={preventHoveredTabMiddleMouse}
          onPointerDown={(event) => {
            if (event.target instanceof HTMLCanvasElement) {
              initialAutoFitRef.current.cancel();
            }
          }}
          onWheel={(event) => {
            if (event.target instanceof HTMLCanvasElement) {
              initialAutoFitRef.current.cancel();
            }
          }}
        >
          {graphQuery.isPending ? (
            <GraphState
              title={t("Loading graph")}
              detail={t("Reading tabs, topics, and links...")}
            />
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
          {graphQuery.isSuccess && scene.nodes.length === 0 ? (
            <GraphState
              title={rootTag ? t("No tabs in this topic") : t("No graph nodes yet")}
              detail={
                rootTag
                  ? t("Choose another topic or assign tabs to this branch.")
                  : t("Capture tabs or create topics to start building the knowledge graph.")
              }
            />
          ) : null}
          {graphQuery.isSuccess && scene.nodes.length > 0 ? (
            <GraphRendererBoundary
              key={rootTopicId ?? "all"}
              fallback={
                <GraphState
                  title={t("3D view is unavailable")}
                  detail={t("WebGL could not start. You can still manage topics and tabs in the Library.")}
                />
              }
            >
              <ForceGraph3D<GraphSceneNode, GraphSceneLink>
                ref={graphRef}
                backgroundColor="#090c12"
                cooldownTicks={highDensity ? 90 : 140}
                cooldownTime={highDensity ? 4_500 : 7_000}
                enableNodeDrag={!highDensity}
                graphData={scene}
                height={size.height}
                linkColor={(link) =>
                  neighborhood && !neighborhood.edgeIds.has(link.id)
                    ? "rgba(18, 23, 34, 0.08)"
                    : EDGE_COLORS[link.edge.edgeType]
                }
                linkDirectionalArrowColor={(link) => EDGE_COLORS[link.edge.edgeType]}
                linkDirectionalArrowLength={(link) =>
                  link.edge.edgeType === "relation" &&
                  (!neighborhood || neighborhood.edgeIds.has(link.id))
                    ? 2.8
                    : 0
                }
                linkDirectionalArrowResolution={highDensity ? 3 : 6}
                linkLabel={(link) =>
                  escapeHtml(link.edge.relationKind ?? t(link.edge.edgeType))
                }
                linkOpacity={0.48}
                linkResolution={highDensity ? 3 : 6}
                linkWidth={(link) =>
                  neighborhood && !neighborhood.edgeIds.has(link.id)
                    ? 0
                    : link.edge.edgeType === "relation"
                      ? 0.72
                      : 0
                }
                nodeId="key"
                nodeLabel={(node) =>
                  `<strong>${escapeHtml(displayTitle(node))}</strong><br>${escapeHtml(
                    nodeTypeLabel(node, t),
                  )}`
                }
                nodeResolution={highDensity ? 6 : 10}
                nodeThreeObject={makeNodeObject}
                numDimensions={3}
                showNavInfo={false}
                warmupTicks={highDensity ? 24 : 45}
                width={size.width}
                onBackgroundClick={() => setSelectedKey(null)}
                onEngineStop={() => {
                  if (selectedNode) {
                    initialAutoFitRef.current.cancel();
                    return;
                  }
                  if (!initialAutoFitRef.current.consume()) return;
                  graphRef.current?.zoomToFit(500, 70);
                }}
                onNodeClick={(node) => selectNode(node.key)}
                onNodeHover={(node) => {
                  hoveredNodeRef.current = node ?? null;
                }}
              />
            </GraphRendererBoundary>
          ) : null}
          <div className="graph-3d-legend" aria-label={t("Graph legend")}>
            <span><i className="is-topic" />{t("Topics")}</span>
            <span><i className="is-tab" />{t("Tabs")}</span>
            <span><b className="is-relation" />{t("Relations")}</span>
          </div>
        </div>

        <NodeInspector
          activationErrorForTab={(tabId) =>
            activationErrorForTab(tabId) ?? closeErrorForTab(tabId)
          }
          activationInProgress={activationInProgress}
          connectedLinks={connectedLinks}
          deleteError={deleteMutation.error}
          deletingRelationId={
            deleteMutation.isPending ? deleteMutation.variables : null
          }
          isActivatingTab={isActivatingTab}
          isClosingTab={isClosingTab}
          node={selectedNode}
          sceneNodes={scene.nodes}
          onBrowserAction={onBrowserAction}
          onCloseTab={onCloseTab}
          onDeleteRelation={(id) => deleteMutation.mutate(id)}
          onOpenNode={openNode}
          onRelationCreated={refreshGraph}
          onSelectNode={selectNode}
        />
      </div>
    </section>
  );
}
