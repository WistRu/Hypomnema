import type { TagTreeNode } from "@tabhub/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type CSSProperties,
  type FormEvent,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";

import {
  createTopic,
  deleteTopic,
  fetchTagTree,
  updateTopic,
  type CreateTopicInput,
  type UpdateTopicInput,
} from "./api";
import { useI18n } from "./i18n";
import { defaultTopicPath } from "./system-topics";
import "./TopicSidebar.css";

export interface SelectedTopic {
  id: number;
  path: string;
}

export interface FlatTopic extends SelectedTopic {
  children: TagTreeNode[];
  color: string | null;
  depth: number;
  name: string;
  parentId: number | null;
  tabCount: number;
}

type TopicEditorState =
  | { mode: "create"; parentId: number | null; parentPath: string | null }
  | { mode: "edit"; topic: FlatTopic };

export function flattenTopics(
  nodes: TagTreeNode[],
  parentId: number | null = null,
  depth = 0,
): FlatTopic[] {
  return nodes.flatMap((node) => [
    {
      children: node.children,
      color: node.color,
      depth,
      id: node.id,
      name: node.name,
      parentId,
      path: node.path,
      tabCount: node.tabCount,
    },
    ...flattenTopics(node.children, node.id, depth + 1),
  ]);
}

export function topicAndDescendantIds(topic: FlatTopic): Set<number> {
  const ids = new Set<number>([topic.id]);
  const visit = (nodes: TagTreeNode[]) => {
    for (const node of nodes) {
      ids.add(node.id);
      visit(node.children);
    }
  };
  visit(topic.children);
  return ids;
}

function topicPath(
  name: string,
  parentId: number | null | undefined,
  topics: FlatTopic[],
): string {
  if (parentId === null || parentId === undefined) return name;
  const parent = topics.find((topic) => topic.id === parentId);
  return parent ? `${parent.path}/${name}` : name;
}

function TopicEditor({
  editor,
  isSaving,
  topics,
  onCancel,
  onCreate,
  onUpdate,
}: {
  editor: TopicEditorState;
  isSaving: boolean;
  topics: FlatTopic[];
  onCancel: () => void;
  onCreate: (input: CreateTopicInput) => void;
  onUpdate: (id: number, input: UpdateTopicInput) => void;
}) {
  const { t } = useI18n();
  const nameId = useId();
  const parentId = useId();
  const colorId = useId();
  const editingTopic = editor.mode === "edit" ? editor.topic : null;
  const initialParentId =
    editor.mode === "edit" ? editor.topic.parentId : editor.parentId;
  const createParentPath = editor.mode === "create" ? editor.parentPath : null;
  const [name, setName] = useState(editingTopic?.name ?? "");
  const [selectedParentId, setSelectedParentId] = useState<number | null>(
    initialParentId,
  );
  const [color, setColor] = useState(editingTopic?.color ?? "#687eff");
  const [useColor, setUseColor] = useState(editingTopic?.color !== null);
  const excludedIds = useMemo(
    () => editingTopic ? topicAndDescendantIds(editingTopic) : new Set<number>(),
    [editingTopic],
  );
  const parentOptions = topics.filter((topic) => !excludedIds.has(topic.id));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedName = name.trim();
    if (!normalizedName) return;
    const input = {
      color: useColor ? color : null,
      name: normalizedName,
      ...(selectedParentId === null ? {} : { parentId: selectedParentId }),
    };

    if (editingTopic) {
      onUpdate(editingTopic.id, {
        ...input,
        parentId: selectedParentId,
      });
    } else {
      onCreate(input);
    }
  };

  return (
    <form className="topic-editor" onSubmit={submit}>
      <strong>
        {editingTopic
          ? t("Edit topic {topic}", { topic: editingTopic.name })
          : createParentPath
            ? t("Create subtopic under {topic}", { topic: createParentPath })
            : t("Create top-level topic")}
      </strong>
      <label htmlFor={nameId}>{t("Topic name")}</label>
      <input
        autoFocus
        disabled={isSaving}
        id={nameId}
        maxLength={128}
        required
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <label htmlFor={parentId}>{t("Parent topic")}</label>
      <select
        disabled={isSaving}
        id={parentId}
        value={selectedParentId ?? ""}
        onChange={(event) =>
          setSelectedParentId(event.target.value ? Number(event.target.value) : null)
        }
      >
        <option value="">{t("Top level")}</option>
        {parentOptions.map((topic) => (
          <option key={topic.id} value={topic.id}>
            {`${"— ".repeat(topic.depth)}${topic.name}`}
          </option>
        ))}
      </select>
      <label className="topic-color-toggle">
        <input
          checked={useColor}
          disabled={isSaving}
          type="checkbox"
          onChange={(event) => setUseColor(event.target.checked)}
        />
        <span>{t("Use custom color")}</span>
      </label>
      <label className="topic-color-field" htmlFor={colorId}>
        <span>{t("Topic color")}</span>
        <input
          disabled={isSaving || !useColor}
          id={colorId}
          type="color"
          value={color}
          onChange={(event) => setColor(event.target.value)}
        />
      </label>
      <div className="topic-editor-actions">
        <button disabled={isSaving || !name.trim()} type="submit">
          {editingTopic ? t("Save topic") : t("Create topic")}
        </button>
        <button disabled={isSaving} type="button" onClick={onCancel}>
          {t("Cancel")}
        </button>
      </div>
    </form>
  );
}

export function TopicTree({
  nodes,
  selectedTopic,
  onAddChild,
  onDelete,
  onEdit,
  onSelect,
}: {
  nodes: TagTreeNode[];
  selectedTopic: SelectedTopic | null;
  onAddChild: (topic: TagTreeNode) => void;
  onDelete: (topic: TagTreeNode) => void;
  onEdit: (topic: TagTreeNode) => void;
  onSelect: (topic: SelectedTopic) => void;
}) {
  const { formatNumber, t } = useI18n();
  return (
    <ul className="topic-tree">
      {nodes.map((node) => {
        const hasChildren = node.children.length > 0;
        const isDefaultTopic = node.path === defaultTopicPath;
        const displayName = isDefaultTopic ? t("No topic") : node.name;
        const colorStyle = node.color
          ? ({ "--topic-color": node.color } as CSSProperties)
          : undefined;
        return (
          <li key={node.id}>
            <div className="topic-tree-row" style={colorStyle}>
              <button
                aria-current={selectedTopic?.id === node.id ? "page" : undefined}
                className="topic-tree-select"
                title={isDefaultTopic ? displayName : node.path}
                type="button"
                onClick={() => onSelect({ id: node.id, path: node.path })}
              >
                <span className="topic-color-dot" aria-hidden="true" />
                <span>{displayName}</span>
                <strong>{formatNumber(node.tabCount)}</strong>
              </button>
              {!isDefaultTopic ? (
                <div className="topic-tree-actions">
                  <button
                    aria-label={t("Add subtopic to {topic}", { topic: node.path })}
                    title={t("Add subtopic")}
                    type="button"
                    onClick={() => onAddChild(node)}
                  >
                    +
                  </button>
                  <button
                    aria-label={t("Edit topic {topic}", { topic: node.path })}
                    title={t("Rename or move topic")}
                    type="button"
                    onClick={() => onEdit(node)}
                  >
                    ···
                  </button>
                  <button
                    aria-label={t("Delete topic {topic}", { topic: node.path })}
                    disabled={hasChildren}
                    title={
                      hasChildren
                        ? t("Topics with subtopics cannot be deleted.")
                        : t("Delete topic")
                    }
                    type="button"
                    onClick={() => onDelete(node)}
                  >
                    ×
                  </button>
                </div>
              ) : null}
            </div>
            {hasChildren ? (
              <TopicTree
                nodes={node.children}
                selectedTopic={selectedTopic}
                onAddChild={onAddChild}
                onDelete={onDelete}
                onEdit={onEdit}
                onSelect={onSelect}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function TopicSidebar({
  selectedTopic,
  onSelectTopic,
}: {
  selectedTopic: SelectedTopic | null;
  onSelectTopic: (topic: SelectedTopic | null) => void;
}) {
  const queryClient = useQueryClient();
  const { errorMessage, t } = useI18n();
  const [editor, setEditor] = useState<TopicEditorState | null>(null);
  const topicsQuery = useQuery({
    queryKey: ["tags"],
    queryFn: ({ signal }) => fetchTagTree(signal),
  });
  const flatTopics = useMemo(
    () => flattenTopics(topicsQuery.data?.items ?? []),
    [topicsQuery.data?.items],
  );

  const refreshTopics = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["tags"] }),
      queryClient.invalidateQueries({ queryKey: ["tabs"] }),
      queryClient.invalidateQueries({ queryKey: ["tab-instances", "library"] }),
      queryClient.invalidateQueries({ queryKey: ["tab"] }),
      queryClient.invalidateQueries({ queryKey: ["graph"] }),
    ]);
  };
  const createMutation = useMutation({
    mutationFn: createTopic,
    onSuccess: async (created, input) => {
      onSelectTopic({
        id: created.id,
        path: topicPath(created.name, input.parentId, flatTopics),
      });
      setEditor(null);
      await refreshTopics();
    },
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: number; input: UpdateTopicInput }) =>
      updateTopic(id, input),
    onSuccess: async (updated, variables) => {
      if (selectedTopic?.id === updated.id) {
        onSelectTopic({
          id: updated.id,
          path: topicPath(updated.name, variables.input.parentId, flatTopics),
        });
      }
      setEditor(null);
      await refreshTopics();
    },
  });
  const deleteMutation = useMutation({
    mutationFn: ({ id }: { id: number; path: string }) => deleteTopic(id),
    onSuccess: async (_result, deleted) => {
      if (selectedTopic?.id === deleted.id) onSelectTopic(null);
      setEditor(null);
      await refreshTopics();
    },
  });
  const busy =
    createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;
  const mutationError =
    createMutation.error ?? updateMutation.error ?? deleteMutation.error;

  useEffect(() => {
    if (!selectedTopic || !topicsQuery.isSuccess) return;
    const current = flatTopics.find((topic) => topic.id === selectedTopic.id);
    if (!current) {
      onSelectTopic(null);
    } else if (current.path !== selectedTopic.path) {
      onSelectTopic({ id: current.id, path: current.path });
    }
  }, [flatTopics, onSelectTopic, selectedTopic, topicsQuery.isSuccess]);

  const resetMutationErrors = () => {
    createMutation.reset();
    updateMutation.reset();
    deleteMutation.reset();
  };
  const beginEdit = (node: TagTreeNode) => {
    const topic = flatTopics.find((candidate) => candidate.id === node.id);
    if (!topic) return;
    resetMutationErrors();
    setEditor({ mode: "edit", topic });
  };

  return (
    <aside className="topic-sidebar" aria-labelledby="topic-tree-title">
      <div className="topic-sidebar-heading">
        <div>
          <p>{t("Organize")}</p>
          <h2 id="topic-tree-title">{t("Topics")}</h2>
        </div>
        <div className="topic-sidebar-heading-actions">
          {topicsQuery.isFetching ? (
            <span className="topic-mini-spinner" aria-hidden="true" />
          ) : null}
          <button
            aria-label={t("Add topic")}
            disabled={busy}
            title={t("Create top-level topic")}
            type="button"
            onClick={() => {
              resetMutationErrors();
              setEditor({ mode: "create", parentId: null, parentPath: null });
            }}
          >
            +
          </button>
        </div>
      </div>
      <nav aria-label={t("Filter tabs by topic")}>
        <button
          aria-current={selectedTopic === null ? "page" : undefined}
          className="topic-all-button"
          type="button"
          onClick={() => onSelectTopic(null)}
        >
          <span>{t("All tabs")}</span>
        </button>
        {topicsQuery.data?.items.length ? (
          <TopicTree
            nodes={topicsQuery.data.items}
            selectedTopic={selectedTopic}
            onAddChild={(node) => {
              resetMutationErrors();
              setEditor({ mode: "create", parentId: node.id, parentPath: node.path });
            }}
            onDelete={(node) => {
              if (
                window.confirm(t("Delete topic “{name}”?", { name: node.path }))
              ) {
                deleteMutation.mutate({ id: node.id, path: node.path });
              }
            }}
            onEdit={beginEdit}
            onSelect={onSelectTopic}
          />
        ) : null}
        {topicsQuery.isPending ? (
          <p className="topic-sidebar-state" role="status">
            {t("Loading topics...")}
          </p>
        ) : null}
        {topicsQuery.isError ? (
          <div className="topic-sidebar-state is-error" role="alert">
            <span>{errorMessage(topicsQuery.error)}</span>
            <button type="button" onClick={() => void topicsQuery.refetch()}>
              {t("Retry")}
            </button>
          </div>
        ) : null}
        {topicsQuery.isSuccess && topicsQuery.data.items.length === 0 ? (
          <p className="topic-sidebar-state">
            {t("Create a top-level topic or assign one to a tab.")}
          </p>
        ) : null}
      </nav>
      {editor ? (
        <TopicEditor
          key={editor.mode === "edit" ? `edit:${editor.topic.id}` : `create:${editor.parentId}`}
          editor={editor}
          isSaving={busy}
          topics={flatTopics.filter((topic) => topic.path !== defaultTopicPath)}
          onCancel={() => {
            resetMutationErrors();
            setEditor(null);
          }}
          onCreate={(input) => createMutation.mutate(input)}
          onUpdate={(id, input) => updateMutation.mutate({ id, input })}
        />
      ) : null}
      {mutationError ? (
        <p className="topic-sidebar-mutation-error" role="alert">
          {errorMessage(mutationError)}
        </p>
      ) : null}
    </aside>
  );
}
