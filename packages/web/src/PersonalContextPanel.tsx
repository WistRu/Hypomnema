import {
  type ContextEntry,
  type ContextEntryKind,
  type ContextVisibility,
  type ExactTabScope,
  type SessionIntent,
  type SessionIntentState,
  type TabInstance,
} from "@tabhub/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type RefObject, useEffect, useMemo, useRef, useState } from "react";

import {
  ApiRequestError,
  changeLocalPageContext,
  changeLocalSessionIntent,
  fetchFeatureFlags,
  fetchLocalPageContext,
  fetchLocalSessionIntents,
} from "./api";
import { type TranslationParams, useI18n } from "./i18n";
import { PairBrowser } from "./PairBrowser";

interface PersonalContextPanelProps {
  exactScopeRequest?: { instanceId: number; nonce: number } | null;
  instances: readonly TabInstance[];
  instancesError?: unknown;
  instancesPending?: boolean;
  tabId: number;
}

type ScopeMode = "page" | "tab";
type LocalizedMessage = { key: string; params?: TranslationParams };
type Receipt =
  | { message: LocalizedMessage; undo: null }
  | {
      message: LocalizedMessage;
      undo:
        | { entryId: number; kind: "restore" }
        | {
            entryId: number;
            kind: "replace";
            previous: Pick<ContextEntry, "body" | "entryKind" | "visibility">;
          }
        | { entryId: number; kind: "withdraw" }
        | {
            intent: Pick<SessionIntent, "expectedPage" | "id" | "scope">;
            kind: "archive-intent";
          }
        | {
            kind: "restore-intent";
            previous: {
              body: string;
              expectedUrl: string;
              scope: ExactTabScope;
              staleAt: string | null;
              visibility: ContextVisibility;
            };
          };
    };

function localizedMessage(
  key: string,
  params?: TranslationParams,
): LocalizedMessage {
  return params === undefined ? { key } : { key, params };
}

const contextKinds: Array<{ label: string; value: ContextEntryKind }> = [
  { label: "Purpose", value: "purpose" },
  { label: "Interest", value: "interest" },
  { label: "Question", value: "question" },
  { label: "Project", value: "project" },
  { label: "Next action", value: "next_action" },
  { label: "Disposition", value: "disposition" },
  { label: "Note", value: "note" },
];
const promotionKinds = contextKinds.filter(({ value }) => value !== "disposition");

const quickContextPresets = [
  { body: "do", entryKind: "next_action", label: "Do" },
  { body: "research", entryKind: "next_action", label: "Research" },
  { body: "reference", entryKind: "purpose", label: "Reference" },
  { body: "compare", entryKind: "next_action", label: "Compare" },
  { body: "temporary", entryKind: "note", label: "Temporary" },
  { body: "not_useful", entryKind: "disposition", label: "Not useful" },
  {
    body: "already_handled",
    entryKind: "disposition",
    label: "Already handled",
  },
] as const satisfies ReadonlyArray<{
  body: string;
  entryKind: ContextEntryKind;
  label: string;
}>;

type QuickContextPreset = (typeof quickContextPresets)[number];

function idempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function exactScope(instance: TabInstance | undefined): ExactTabScope | null {
  if (
    instance === undefined ||
    instance.browserSessionId === null ||
    instance.browserTabId === null
  ) {
    return null;
  }
  return {
    browserSessionId: instance.browserSessionId,
    browserTabId: instance.browserTabId,
    installationId: instance.installationId,
  };
}

function actionSignature(kind: string, value: unknown): string {
  return `${kind}:${JSON.stringify(value)}`;
}

function entryLabel(entry: ContextEntry, t: ReturnType<typeof useI18n>["t"]): string {
  if (entry.entryKind === "disposition") {
    return entry.body === "not_useful" ? t("Not useful") : t("Already handled");
  }
  return t(contextKinds.find(({ value }) => value === entry.entryKind)?.label ?? "Note");
}

function entryBody(entry: ContextEntry, t: ReturnType<typeof useI18n>["t"]): string {
  return entry.entryKind === "disposition" ? entryLabel(entry, t) : entry.body;
}

function contextStateLabel(
  state: ContextEntry["state"],
  t: ReturnType<typeof useI18n>["t"],
): string {
  return state === "active" ? t("Active") : t("Withdrawn");
}

function contextOperationLabel(
  operation: ContextEntry["operation"],
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (operation === "append") return t("Added");
  if (operation === "withdraw") return t("Removed");
  return t("Restored");
}

function intentStateLabel(
  state: SessionIntentState,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (state === "active") return t("Active");
  if (state === "archived") return t("Archived");
  if (state === "promoted") return t("Promoted");
  return t("Expired");
}

export function PersonalContextPanel({
  exactScopeRequest = null,
  instances,
  instancesError,
  instancesPending = false,
  tabId,
}: PersonalContextPanelProps) {
  const { errorMessage, formatDate, formatNumber, t } = useI18n();
  const queryClient = useQueryClient();
  const retryKeys = useRef(new Map<string, string>());
  const editorRef = useRef<HTMLTextAreaElement | HTMLSelectElement>(null);
  const [scopeMode, setScopeMode] = useState<ScopeMode>("page");
  const [selectedInstanceId, setSelectedInstanceId] = useState<number | null>(null);
  const [body, setBody] = useState("");
  const [entryKind, setEntryKind] = useState<ContextEntryKind>("purpose");
  const [quickPreset, setQuickPreset] = useState<QuickContextPreset | null>(null);
  const [promotionKind, setPromotionKind] = useState<ContextEntryKind>("purpose");
  const [editing, setEditing] = useState<ContextEntry | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [announcement, setAnnouncement] = useState<LocalizedMessage | null>(null);

  // Personal context exists so the AI can read it, so anything written now is
  // AI-visible and the choice is gone (issue #30). Revising a stored entry is
  // the one exception: a revision joins that entry's supersede chain, so it
  // keeps the visibility the original was stored with rather than widening it.
  // Derived rather than held in state on purpose — a remembered value outlives
  // the entry it came from and leaks into the next, unrelated entry.
  const visibility: ContextVisibility = editing?.visibility ?? "share_with_ai";

  const featuresQuery = useQuery({
    queryKey: ["features"],
    queryFn: ({ signal }) => fetchFeatureFlags(signal),
    staleTime: 30_000,
  });
  const enabled = featuresQuery.data?.context === true;
  const controllable = useMemo(
    () =>
      instances.filter(
        (instance) =>
          instance.browserSessionId !== null && instance.browserTabId !== null,
      ),
    [instances],
  );

  useEffect(() => {
    if (controllable.length === 0) {
      setSelectedInstanceId(null);
    } else if (controllable.length === 1) {
      setSelectedInstanceId(controllable[0]!.instanceId);
    } else if (!controllable.some(({ instanceId }) => instanceId === selectedInstanceId)) {
      setSelectedInstanceId(null);
    }
  }, [controllable, selectedInstanceId]);

  useEffect(() => {
    if (quickPreset !== null) editorRef.current?.focus();
  }, [quickPreset]);

  useEffect(() => {
    if (
      exactScopeRequest !== null &&
      controllable.some(({ instanceId }) => instanceId === exactScopeRequest.instanceId)
    ) {
      setSelectedInstanceId(exactScopeRequest.instanceId);
      setScopeMode("tab");
      requestAnimationFrame(() => editorRef.current?.focus());
    }
  }, [controllable, exactScopeRequest]);

  const selectedInstance = controllable.find(
    ({ instanceId }) => instanceId === selectedInstanceId,
  );
  const selectedScope = exactScope(selectedInstance);
  const contextQuery = useQuery({
    queryKey: ["personal-context", tabId],
    queryFn: ({ signal }) => fetchLocalPageContext(tabId, signal),
    enabled,
  });
  const intentQuery = useQuery({
    queryKey: ["session-intent", selectedScope],
    queryFn: ({ signal }) => fetchLocalSessionIntents(selectedScope!, signal),
    enabled: enabled && selectedScope !== null,
  });

  const refreshContext = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["personal-context", tabId] }),
      queryClient.invalidateQueries({ queryKey: ["tabs"] }),
    ]);
  };
  const refreshIntent = async () => {
    await queryClient.invalidateQueries({ queryKey: ["session-intent"] });
  };
  const stableKey = (signature: string) => {
    const existing = retryKeys.current.get(signature);
    if (existing !== undefined) return existing;
    const created = idempotencyKey();
    retryKeys.current.set(signature, created);
    return created;
  };
  const complete = (
    signature: string,
    message: LocalizedMessage,
    nextReceipt: Receipt,
  ) => {
    retryKeys.current.delete(signature);
    setAnnouncement(message);
    setReceipt(nextReceipt);
  };

  const contextMutation = useMutation({
    mutationFn: (input: {
      command: Parameters<typeof changeLocalPageContext>[1];
      logicalPageId: number;
    }) => changeLocalPageContext(input.logicalPageId, input.command),
  });
  const intentMutation = useMutation({
    mutationFn: (command: Parameters<typeof changeLocalSessionIntent>[0]) =>
      changeLocalSessionIntent(command),
  });
  const resetEditor = () => {
    setBody("");
    setEntryKind("purpose");
    setQuickPreset(null);
    setEditing(null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const text = body.trim();
    if (!text || contextQuery.data === undefined) return;
    try {
      if (scopeMode === "page") {
        const subject = contextQuery.data.context.subject;
        if (subject.type !== "page") return;
        const signature = actionSignature("context-append", {
          body: text,
          entryKind,
          supersedesEntryId: editing?.id,
          visibility,
        });
        const result = await contextMutation.mutateAsync({
          logicalPageId: subject.logicalPageId,
          command: {
            kind: "append",
            entryKind,
            body: text,
            visibility,
            ...(editing === null ? {} : { supersedesEntryId: editing.id }),
            idempotencyKey: stableKey(signature),
          },
        });
        if (result.kind !== "changed") return;
        complete(signature, localizedMessage("Personal context saved."), {
          message: localizedMessage("Personal context saved."),
          undo:
            editing === null
              ? { entryId: result.entry.id, kind: "withdraw" }
              : {
                  entryId: result.entry.id,
                  kind: "replace",
                  previous: {
                    body: editing.body,
                    entryKind: editing.entryKind,
                    visibility: editing.visibility,
                  },
                },
        });
        resetEditor();
        await refreshContext();
      } else if (selectedScope !== null && selectedInstance !== undefined) {
        const signature = actionSignature("intent-set", {
          body: text,
          expectedUrl: selectedInstance.url,
          scope: selectedScope,
          visibility,
        });
        const result = await intentMutation.mutateAsync({
          kind: "set",
          scope: selectedScope,
          expectedUrl: selectedInstance.url,
          body: text,
          visibility,
          idempotencyKey: stableKey(signature),
        });
        if (result.kind !== "set") return;
        complete(signature, localizedMessage("Open-tab intent saved."), {
          message: localizedMessage("Open-tab intent saved."),
          undo:
            activeIntent === null
              ? {
                  intent: {
                    expectedPage: result.intent.expectedPage,
                    id: result.intent.id,
                    scope: result.intent.scope,
                  },
                  kind: "archive-intent",
                }
              : {
                  kind: "restore-intent",
                  previous: {
                    body: activeIntent.body,
                    expectedUrl: activeIntent.expectedPage.url,
                    scope: activeIntent.scope,
                    staleAt: activeIntent.staleAt,
                    visibility: activeIntent.visibility,
                  },
                },
        });
        resetEditor();
        await refreshIntent();
      }
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "SESSION_SCOPE_STALE") {
        setAnnouncement(localizedMessage("This open tab changed. Refresh its copies and try again."));
        await queryClient.invalidateQueries({ queryKey: ["tab-instances"] });
      }
    }
  };

  const changeEntry = async (
    entry: ContextEntry,
    kind: "restore" | "withdraw",
  ) => {
    const subject = contextQuery.data?.context.subject;
    const logicalPageId = subject?.type === "page" ? subject.logicalPageId : undefined;
    if (logicalPageId === undefined) return;
    const signature = actionSignature(`context-${kind}`, entry.id);
    const result = await contextMutation.mutateAsync({
      logicalPageId,
      command: { kind, entryId: entry.id, idempotencyKey: stableKey(signature) },
    });
    if (result.kind !== "changed") return;
    const message = localizedMessage(
      kind === "withdraw" ? "Context removed." : "Context restored.",
    );
    complete(signature, message, {
      message,
      undo:
        kind === "withdraw"
          ? { entryId: result.entry.id, kind: "restore" }
          : { entryId: result.entry.id, kind: "withdraw" },
    });
    await refreshContext();
  };

  const reviewEntry = async (entry: ContextEntry, verdict: "accepted" | "rejected") => {
    const subject = contextQuery.data?.context.subject;
    const logicalPageId = subject?.type === "page" ? subject.logicalPageId : undefined;
    if (logicalPageId === undefined) return;
    const signature = actionSignature("context-review", { entryId: entry.id, verdict });
    const result = await contextMutation.mutateAsync({
      logicalPageId,
      command: {
        kind: "review",
        entryId: entry.id,
        verdict,
        idempotencyKey: stableKey(signature),
      },
    });
    if (result.kind !== "reviewed") return;
    const message = localizedMessage(
      verdict === "accepted" ? "Suggestion accepted." : "Suggestion rejected.",
    );
    complete(signature, message, { message, undo: null });
    await refreshContext();
  };

  const archiveIntent = async (
    intent: Pick<SessionIntent, "expectedPage" | "id" | "scope">,
  ) => {
    const signature = actionSignature("intent-archive", intent.id);
    const result = await intentMutation.mutateAsync({
      kind: "archive",
      intentId: intent.id,
      scope: intent.scope,
      expectedPage: intent.expectedPage,
      idempotencyKey: stableKey(signature),
    });
    if (result.kind !== "archived") return;
    complete(signature, localizedMessage("Open-tab intent archived."), {
      message: localizedMessage("Open-tab intent archived."),
      undo: null,
    });
    await refreshIntent();
  };

  const promoteIntent = async (intent: SessionIntent) => {
    const contextKind = promotionKind;
    const signature = actionSignature("intent-promote", {
      contextKind,
      intentId: intent.id,
    });
    const result = await intentMutation.mutateAsync({
      kind: "promote",
      intentId: intent.id,
      contextKind,
      scope: intent.scope,
      expectedPage: intent.expectedPage,
      idempotencyKey: stableKey(signature),
    });
    if (result.kind !== "promoted") return;
    complete(signature, localizedMessage("Intent promoted to page context."), {
      message: localizedMessage("Intent promoted to page context."),
      undo: null,
    });
    await Promise.all([refreshIntent(), refreshContext()]);
  };

  const undoReceipt = async () => {
    const currentReceipt = receipt;
    if (currentReceipt === null || currentReceipt.undo === null || contextQuery.data === undefined) return;
    const undo = currentReceipt.undo;
    try {
      if (undo.kind === "archive-intent") {
        await archiveIntent(undo.intent);
        setAnnouncement(localizedMessage("Save undone."));
        setReceipt({ message: localizedMessage("Save undone."), undo: null });
        return;
      }
      if (undo.kind === "restore-intent") {
        const signature = actionSignature("intent-undo-replacement", undo.previous);
        const result = await intentMutation.mutateAsync({
          kind: "set",
          ...undo.previous,
          idempotencyKey: stableKey(signature),
        });
        if (result.kind !== "set") return;
        retryKeys.current.delete(signature);
        setAnnouncement(localizedMessage("Change undone."));
        setReceipt({ message: localizedMessage("Change undone."), undo: null });
        await refreshIntent();
        return;
      }
      const subject = contextQuery.data.context.subject;
      if (subject.type !== "page") return;
      const logicalPageId = subject.logicalPageId;
      const signature = actionSignature("context-undo", undo);
      const command =
        undo.kind === "replace"
          ? {
              kind: "append" as const,
              ...undo.previous,
              supersedesEntryId: undo.entryId,
              idempotencyKey: stableKey(signature),
            }
          : {
              kind: undo.kind,
              entryId: undo.entryId,
              idempotencyKey: stableKey(signature),
            };
      await contextMutation.mutateAsync({ logicalPageId, command });
      retryKeys.current.delete(signature);
      setAnnouncement(localizedMessage("Change undone."));
      setReceipt({ message: localizedMessage("Change undone."), undo: null });
      await refreshContext();
    } catch {
      // Mutation error remains visible in the common alert below.
    }
  };

  if (featuresQuery.isPending) {
    return <div className="personal-context-state" role="status">{t("Checking personal context")}</div>;
  }
  if (featuresQuery.isError) {
    return (
      <div className="personal-context-state">
        <p role="alert">{errorMessage(featuresQuery.error)}</p>
        <button type="button" onClick={() => void featuresQuery.refetch()}>{t("Try again")}</button>
      </div>
    );
  }
  if (!enabled) return null;

  const currentEntries = contextQuery.data?.context.currentEntries ?? [];
  const activeIntent = intentQuery.data?.current ?? null;
  const mutationError = contextMutation.error ?? intentMutation.error;

  return (
    <section className="personal-context-panel" aria-labelledby={`personal-context-${tabId}`}>
      <div className="section-heading">
        <div>
          <h3 id={`personal-context-${tabId}`}>{t("Personal context")}</h3>
          <p>{t("Why this page matters or why this exact tab is open.")}</p>
        </div>
        {contextQuery.data ? (
          <span>
            {t("{count} browser copies", {
              count: contextQuery.data.affectedBrowserPageCount,
            })}
          </span>
        ) : null}
      </div>

      {contextQuery.isPending ? <p role="status">{t("Loading personal context")}</p> : null}
      {contextQuery.isError ? (
        <div className="personal-context-state">
          <p role="alert">{errorMessage(contextQuery.error)}</p>
          <button type="button" onClick={() => void contextQuery.refetch()}>{t("Try again")}</button>
        </div>
      ) : null}

      {contextQuery.data ? (
        <>
          <fieldset className="context-scope-switch">
            <legend>{t("Save for")}</legend>
            <label>
              <input
                checked={scopeMode === "page"}
                name={`context-scope-${tabId}`}
                type="radio"
                onChange={() => {
                  setScopeMode("page");
                  setQuickPreset(null);
                }}
              />
              <span>{t("This page in all browsers")}</span>
            </label>
            <label>
              <input
                checked={scopeMode === "tab"}
                disabled={controllable.length === 0}
                name={`context-scope-${tabId}`}
                type="radio"
                onChange={() => {
                  setScopeMode("tab");
                  setQuickPreset(null);
                }}
              />
              <span>{t("Only this open tab")}</span>
            </label>
          </fieldset>

          {scopeMode === "tab" ? (
            <div className="exact-tab-picker">
              {instancesPending ? <p role="status">{t("Loading open copies...")}</p> : null}
              {instancesError ? <p role="alert">{errorMessage(instancesError)}</p> : null}
              <label>
                <span>{t("Open copy")}</span>
                <select
                  value={selectedInstanceId ?? ""}
                  onChange={(event) => setSelectedInstanceId(Number(event.target.value))}
                >
                  {controllable.length > 1 ? <option disabled value="">{t("Select an open copy")}</option> : null}
                  {controllable.map((instance) => (
                    <option key={instance.instanceId} value={instance.instanceId}>
                      {instance.browser} · {instance.installationId.slice(0, 8)} · {t("window {windowId}, tab {tabId}", {
                        tabId: instance.browserTabId ?? "?",
                        windowId: instance.windowId,
                      })} · {instance.title?.trim() || t("Untitled tab")} · {instance.url}
                    </option>
                  ))}
                </select>
              </label>
              {selectedInstance ? (
                <p className="context-scope-label" title={selectedInstance.url}>
                  {selectedInstance.browser} · {selectedInstance.installationId.slice(0, 8)} · {selectedInstance.url}
                </p>
              ) : (
                <p className="muted-copy">{t("No addressable open copy is available.")}</p>
              )}
            </div>
          ) : (
            <p className="context-scope-label">
              {t("Applies to {affected} saved browser copies; {open} are open now.", {
                affected: formatNumber(contextQuery.data.affectedBrowserPageCount),
                open: formatNumber(instances.length),
              })}
            </p>
          )}

          <form className="context-editor" onSubmit={save}>
            {scopeMode === "page" ? (
              <label>
                <span>{t("Context kind")}</span>
                <select
                  value={entryKind}
                  onChange={(event) => {
                    const nextKind = event.target.value as ContextEntryKind;
                    setEntryKind(nextKind);
                    setQuickPreset(null);
                    if (nextKind === "disposition" && body !== "not_useful" && body !== "already_handled") {
                      setBody("not_useful");
                    }
                  }}
                >
                  {contextKinds.map((option) => (
                    <option key={option.value} value={option.value}>{t(option.label)}</option>
                  ))}
                </select>
              </label>
            ) : null}
            {scopeMode === "page" && entryKind === "disposition" ? (
              <label className="context-editor-body">
                <span>{t("Disposition")}</span>
                <select
                  ref={editorRef as RefObject<HTMLSelectElement>}
                  value={body === "already_handled" ? "already_handled" : "not_useful"}
                  onChange={(event) => {
                    setBody(event.target.value);
                    setQuickPreset(null);
                  }}
                >
                  <option value="not_useful">{t("Not useful")}</option>
                  <option value="already_handled">{t("Already handled")}</option>
                </select>
              </label>
            ) : (
              <label className="context-editor-body">
                <span>{scopeMode === "page" ? t("Why is this important?") : t("Why is this open now?")}</span>
                <textarea
                  maxLength={100_000}
                  ref={editorRef as RefObject<HTMLTextAreaElement>}
                  rows={4}
                  value={body}
                  onChange={(event) => {
                    setBody(event.target.value);
                    setQuickPreset(null);
                  }}
                />
              </label>
            )}
            {scopeMode === "page" ? (
              <div
                aria-label={t("Quick context presets")}
                className="context-dispositions"
                role="group"
              >
                {quickContextPresets.map((preset) => (
                  <button
                    aria-pressed={quickPreset === preset}
                    key={preset.body}
                    type="button"
                    onClick={() => {
                      setEditing(null);
                      setEntryKind(preset.entryKind);
                      setBody(preset.body);
                      setQuickPreset(preset);
                    }}
                  >
                    {t(preset.label)}
                  </button>
                ))}
              </div>
            ) : null}
            {scopeMode === "page" && quickPreset !== null ? (
              // Issue #33: a chip fills the editor and latches, which reads as
              // "done". Staging is deliberate — the body is meant to be
              // editable before it is stored — so the step has to name the
              // action it still needs rather than look finished. Page scope
              // only, which is the only scope that offers chips at all.
              <p className="context-preset-status" role="status">
                {t('Preset "{preset}" is filled in. Press Save to store it.', {
                  preset: t(quickPreset.label),
                })}
              </p>
            ) : null}
            <div className="context-editor-actions">
              <button
                disabled={
                  !body.trim() ||
                  contextMutation.isPending ||
                  intentMutation.isPending ||
                  (scopeMode === "tab" && selectedScope === null)
                }
                type="submit"
              >
                {editing ? t("Save revision") : t("Save")}
              </button>
              {editing ? <button type="button" onClick={resetEditor}>{t("Cancel")}</button> : null}
            </div>
          </form>

          {scopeMode === "page" ? (
            <div className="context-entry-list">
              <h4>{t("Current page context")}</h4>
              {currentEntries.length === 0 ? <p className="muted-copy">{t("No personal context yet.")}</p> : null}
              {currentEntries.map((entry) => (
                <article className={`context-entry ${entry.provenance.actor === "agent" ? "is-agent" : ""}`} key={entry.id}>
                  <header>
                    <strong>{entryLabel(entry, t)}</strong>
                    <span>{entry.provenance.actor === "user" ? t("You") : t("AI suggestion")}</span>
                  </header>
                  <p>{entryBody(entry, t)}</p>
                  <footer>
                    {entry.visibility === "local_only" ? <span>{t("Local only")}</span> : null}
                    {entry.currentReview ? <span>{entry.currentReview.verdict === "accepted" ? t("Accepted") : t("Rejected")}</span> : null}
                    {entry.state === "active" ? (
                      <>
                        {entry.provenance.actor === "user" ? (
                          <button type="button" onClick={() => { setEditing(entry); setEntryKind(entry.entryKind); setBody(entry.body); setQuickPreset(null); }}>
                            {t("Edit")}
                          </button>
                        ) : (
                          <>
                            <button type="button" onClick={() => void reviewEntry(entry, "accepted").catch(() => undefined)}>{t("Accept")}</button>
                            <button type="button" onClick={() => void reviewEntry(entry, "rejected").catch(() => undefined)}>{t("Reject")}</button>
                          </>
                        )}
                        <button type="button" onClick={() => void changeEntry(entry, "withdraw").catch(() => undefined)}>{t("Remove")}</button>
                      </>
                    ) : (
                      <button type="button" onClick={() => void changeEntry(entry, "restore").catch(() => undefined)}>{t("Restore")}</button>
                    )}
                  </footer>
                </article>
              ))}
              {contextQuery.data.context.entries.length > currentEntries.length ? (
                <details className="context-history">
                  <summary>{t("Revision history")}</summary>
                  <ol>
                     {contextQuery.data.context.entries.map((entry) => (
                       <li key={entry.id}>
                         <div>
                           <span>{formatDate(entry.createdAt)}</span> · {entryLabel(entry, t)} · {entry.provenance.actor === "user" ? t("You") : t("AI suggestion")}
                         </div>
                         <div className="context-history-detail">
                           <span>{entryBody(entry, t)}</span>
                           <span>{t("State")}: <strong>{contextStateLabel(entry.state, t)}</strong></span>
                           <span>{t("Operation")}: <strong>{contextOperationLabel(entry.operation, t)}</strong></span>
                         </div>
                       </li>
                     ))}
                  </ol>
                </details>
              ) : null}
            </div>
          ) : (
            <div className="context-entry-list">
              <h4>{t("Exact open-tab intent")}</h4>
              {intentQuery.isPending ? <p role="status">{t("Loading open-tab intent")}</p> : null}
              {intentQuery.isError ? <p role="alert">{errorMessage(intentQuery.error)}</p> : null}
              {activeIntent ? (
                <article className="context-entry">
                  <header><strong>{t("Open now")}</strong><span>{activeIntent.provenance.actor === "user" ? t("You") : t("AI suggestion")}</span></header>
                  <p>{activeIntent.body}</p>
                   <footer>
                     <button type="button" onClick={() => { setBody(activeIntent.body); setQuickPreset(null); }}>{t("Edit")}</button>
                     <button type="button" onClick={() => void archiveIntent(activeIntent).catch(() => undefined)}>{t("Archive")}</button>
                     <label className="context-promotion-kind">
                       <span>{t("Promote as")}</span>
                       <select
                         value={promotionKind}
                         onChange={(event) => setPromotionKind(event.target.value as ContextEntryKind)}
                       >
                         {promotionKinds.map((option) => (
                           <option key={option.value} value={option.value}>{t(option.label)}</option>
                         ))}
                       </select>
                     </label>
                     <button type="button" onClick={() => void promoteIntent(activeIntent).catch(() => undefined)}>{t("Promote to page context")}</button>
                   </footer>
                </article>
              ) : <p className="muted-copy">{t("No intent for this exact open tab.")}</p>}
              {intentQuery.data && intentQuery.data.history.length > 0 ? (
                <details className="context-history">
                  <summary>{t("Intent history")}</summary>
                  <ol>{intentQuery.data.history.map((intent) => (
                    <li key={intent.id}>
                      {formatDate(intent.createdAt)} · <span>{intentStateLabel(intent.state, t)}</span> · {intent.body}
                    </li>
                  ))}</ol>
                </details>
              ) : null}
            </div>
          )}

          <PairBrowser variant="panel" />
        </>
      ) : null}

      {mutationError ? <p className="drawer-error" role="alert">{errorMessage(mutationError)}</p> : null}
      {receipt ? (
        <div className="context-receipt" role="status">
          <span>{t(receipt.message.key, receipt.message.params)}</span>
          {receipt.undo ? <button type="button" onClick={() => void undoReceipt().catch(() => undefined)}>{t("Undo")}</button> : null}
          <button type="button" onClick={() => setReceipt(null)}>{t("OK")}</button>
        </div>
      ) : null}
      <p className="sr-only" aria-live="polite" role="status">
        {announcement === null ? "" : t(announcement.key, announcement.params)}
      </p>
    </section>
  );
}
