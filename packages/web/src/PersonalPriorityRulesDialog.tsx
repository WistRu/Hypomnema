import {
  personalPriorityDraftSchema,
  personalPriorityNaturalLanguageGrammarV1,
  type PersonalPriorityDraft,
  type PersonalPriorityLifecycleRequest,
} from "@tabhub/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  changePersonalPriorityRules,
  fetchPersonalPriorityRules,
  fetchPersonalPriorityRulesVersion,
  fetchPriorityRecomputeJob,
  previewPersonalPriorityRules,
  submitPriorityRecompute,
} from "./api";
import { useI18n } from "./i18n";
import { activateModalDialog } from "./modal-dialog";
import { createPriorityRecomputeTracker } from "./priority-recompute-tracker";

type LifecycleWithoutFingerprint = PersonalPriorityLifecycleRequest extends infer Request
  ? Request extends PersonalPriorityLifecycleRequest
    ? Omit<Request, "requestFingerprint">
    : never
  : never;
type LifecycleResponse = Awaited<ReturnType<typeof changePersonalPriorityRules>>;
type PreviewResponse = Awaited<ReturnType<typeof previewPersonalPriorityRules>>;
type RulesetVersion = Awaited<ReturnType<typeof fetchPersonalPriorityRulesVersion>>;
type RecomputeView = Awaited<ReturnType<typeof fetchPriorityRecomputeJob>>;

function sameRef(
  left: { readonly rulesetId: number; readonly version: number },
  right: { readonly rulesetId: number; readonly version: number },
) {
  return left.rulesetId === right.rulesetId && left.version === right.version;
}

function structuredDraft(additions: RulesetVersion["additions"]): PersonalPriorityDraft {
  return { kind: "structured", additions };
}

function sourceAtCodePointSpan(
  source: string,
  span: { readonly start: number; readonly end: number },
): string {
  return [...source].slice(span.start, span.end).join("");
}

function errorSourceSpan(cause: unknown) {
  if (typeof cause !== "object" || cause === null || !("span" in cause)) return undefined;
  const span = cause.span;
  return typeof span === "object" && span !== null &&
      "start" in span && typeof span.start === "number" &&
      "end" in span && typeof span.end === "number"
    ? { start: span.start, end: span.end }
    : undefined;
}

export function PersonalPriorityRulesDialog({
  canMutateAndRecompute,
  onDismiss,
  trigger = null,
}: {
  readonly canMutateAndRecompute: boolean;
  readonly onDismiss: () => void;
  readonly trigger?: HTMLElement | null;
}) {
  const { errorMessage, locale, t } = useI18n();
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLElement>(null);
  const editorRevision = useRef(0);
  const localeRef = useRef(locale);
  if (localeRef.current !== locale) {
    localeRef.current = locale;
    editorRevision.current += 1;
  }
  const [draftKind, setDraftKind] = useState<"natural_language" | "structured">(
    "natural_language",
  );
  const [source, setSource] = useState("");
  const [structuredSource, setStructuredSource] = useState("[]");
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewedDraft, setPreviewedDraft] = useState<PersonalPriorityDraft | null>(null);
  const [saved, setSaved] = useState<LifecycleResponse | null>(null);
  const [confirmation, setConfirmation] = useState<LifecycleWithoutFingerprint | null>(null);
  const [notice, setNotice] = useState<{
    readonly key: string;
    readonly params?: Record<string, number | string>;
  } | null>(null);
  const [localError, setLocalError] = useState<unknown>(null);
  const [selectedVersion, setSelectedVersion] = useState<RulesetVersion | null>(null);
  const tracker = useMemo(() => createPriorityRecomputeTracker(window.localStorage), []);
  const [trackedJob, setTrackedJob] = useState(() => tracker.resume());
  const [terminalJob, setTerminalJob] = useState<RecomputeView | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    return activateModalDialog(dialog, trigger, onDismiss);
  }, [onDismiss, trigger]);
  useEffect(() => {
    setPreview(null);
    setPreviewedDraft(null);
    setSaved(null);
    setConfirmation(null);
  }, [locale]);

  const invalidateEditorResult = () => {
    editorRevision.current += 1;
    setPreview(null);
    setPreviewedDraft(null);
    setSaved(null);
    setConfirmation(null);
    setNotice(null);
    setLocalError(null);
  };

  const stateQuery = useQuery({
    queryKey: ["personal-priority-rules"],
    queryFn: ({ signal }) => fetchPersonalPriorityRules(signal),
  });
  const jobQuery = useQuery({
    enabled: trackedJob !== null,
    queryKey: ["priority-recompute-job", trackedJob?.id],
    queryFn: ({ signal }) => fetchPriorityRecomputeJob(trackedJob!.id, signal),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "running" ? 1_000 : false;
    },
  });
  useEffect(() => {
    const status = jobQuery.data?.status;
    if (status === undefined) return;
    tracker.observe(status);
    if (!["queued", "running"].includes(status)) {
      setTerminalJob(jobQuery.data ?? null);
      setTrackedJob(null);
    }
  }, [jobQuery.data?.status, tracker]);

  const currentDraft = (): PersonalPriorityDraft => {
    if (draftKind === "natural_language") {
      return personalPriorityDraftSchema.parse({ kind: draftKind, locale, source });
    }
    return personalPriorityDraftSchema.parse({
      kind: draftKind,
      additions: JSON.parse(structuredSource) as unknown,
    });
  };
  const activeRef = stateQuery.data?.activeRef;
  const previewIsFresh = preview !== null && activeRef !== undefined &&
    sameRef(preview.comparedActiveRef, activeRef);

  const previewMutation = useMutation({
    mutationFn: (input: { readonly draft: PersonalPriorityDraft;
      readonly editorRevision: number; readonly locale: typeof locale }) =>
      previewPersonalPriorityRules(input.draft),
    onSuccess: (result, input) => {
      if (input.editorRevision !== editorRevision.current ||
          input.locale !== localeRef.current) return;
      setPreview(result);
      setPreviewedDraft(input.draft);
      setConfirmation(null);
      setNotice(null);
      setLocalError(null);
    },
  });
  const lifecycleMutation = useMutation({
    mutationFn: (request: LifecycleWithoutFingerprint) => changePersonalPriorityRules(request),
    onSuccess: async (result) => {
      setConfirmation(null);
      if (result.operation === "save") {
        setSaved(result);
        setNotice({ key: "Saved version {version} is inactive.",
          params: { version: result.target.version } });
      } else {
        const key = {
          activate: "Priority rules activated.",
          disable: "Personal priority rules disabled.",
          reset: "Personal priority rules reset.",
          rollback: "Priority rules rolled back.",
        }[result.operation];
        setNotice({ key });
        setSaved(null);
      }
      await queryClient.invalidateQueries({ queryKey: ["personal-priority-rules"] });
    },
  });
  const recomputeMutation = useMutation({
    mutationFn: () => submitPriorityRecompute({
      idempotencyKey: `priority-recompute:${Date.now()}`,
      stepBatchSize: 50,
    }),
    onSuccess: (job) => {
      setTerminalJob(null);
      tracker.remember(job);
      setTrackedJob(job);
    },
  });
  const lifecyclePreviewMutation = useMutation({
    mutationFn: async (input: { readonly kind: "disable" | "reset" | "rollback";
      readonly version?: RulesetVersion }) => {
      if (stateQuery.data === undefined) throw new Error("Priority rules are not ready");
      const targetDraft = input.kind === "rollback" && input.version !== undefined
        ? structuredDraft(input.version.additions) : structuredDraft([]);
      const result = await previewPersonalPriorityRules(targetDraft);
      if (!sameRef(result.comparedActiveRef, stateQuery.data.activeRef)) {
        throw new Error("Active priority rules changed; preview again.");
      }
      const request: LifecycleWithoutFingerprint = input.kind === "disable"
        ? { kind: input.kind, expectedActiveRef: result.comparedActiveRef }
        : input.kind === "reset"
          ? { kind: input.kind, expectedLatestVersion: stateQuery.data.latestVersion,
            expectedActiveRef: result.comparedActiveRef }
          : input.version === undefined
            ? (() => { throw new Error("Rollback version is missing"); })()
            : { kind: input.kind, target: input.version.ref,
              expectedActiveRef: result.comparedActiveRef };
      return { result, request };
    },
    onSuccess: ({ result, request }) => {
      setPreview(result);
      setConfirmation(request);
    },
  });
  const versionMutation = useMutation({
    mutationFn: (ref: RulesetVersion["ref"]) =>
      fetchPersonalPriorityRulesVersion(ref),
    onSuccess: setSelectedVersion,
  });

  const rulesState = stateQuery.data;
  const mutationError = lifecycleMutation.error ??
    lifecyclePreviewMutation.error ?? versionMutation.error ??
    recomputeMutation.error ?? jobQuery.error ?? localError;
  const mutationErrorSpan = errorSourceSpan(mutationError);

  return (
    <section
      aria-labelledby="personal-priority-rules-title"
      aria-modal="true"
      className="personal-priority-rules-dialog"
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
    >
      <header>
        <h2 id="personal-priority-rules-title">{t("Personal priority rules")}</h2>
        <button type="button" onClick={onDismiss}>{t("Close")}</button>
      </header>
      {stateQuery.isPending ? <p role="status">{t("Loading personal priority rules...")}</p> : null}
      {stateQuery.isError ? <p role="alert">{errorMessage(stateQuery.error)}</p> : null}
      {rulesState !== undefined ? (
        <>
          <p>{t("Active version")}: {rulesState.activeRef.rulesetId}/{rulesState.activeRef.version}</p>
          <div role="tablist" aria-label={t("Rule editor mode")}>
            <button aria-selected={draftKind === "natural_language"} role="tab" type="button"
              onClick={() => { invalidateEditorResult(); setDraftKind("natural_language"); }}>
              {t("Natural language")}
            </button>
            <button aria-selected={draftKind === "structured"} role="tab" type="button"
              onClick={() => { invalidateEditorResult(); setDraftKind("structured"); }}>
              {t("Structured rules")}
            </button>
          </div>
          {draftKind === "natural_language" ? (
            <label>{t("Rule source")}
              <textarea aria-label={t("Rule source")} value={source}
                onChange={(event) => { invalidateEditorResult(); setSource(event.target.value); }} />
            </label>
          ) : (
            <label>{t("Structured rule additions (JSON)")}
              <textarea aria-label={t("Structured rule additions (JSON)")}
                value={structuredSource}
                onChange={(event) => { invalidateEditorResult(); setStructuredSource(event.target.value); }} />
            </label>
          )}
          <aside className="priority-rule-grammar-help">
            <strong>{t("Controlled language grammar")}</strong>
            <code>{personalPriorityNaturalLanguageGrammarV1.locales[locale].ruleTemplate}</code>
            {personalPriorityNaturalLanguageGrammarV1.locales[locale].examples.map((example) =>
              <code key={example}>{example}</code>)}
          </aside>
          <button disabled={previewMutation.isPending} type="button"
            onClick={() => {
              try {
                const draft = currentDraft();
                const input = { draft, editorRevision: editorRevision.current, locale };
                void previewMutation.mutateAsync(input).catch((error: unknown) => {
                  if (input.editorRevision === editorRevision.current &&
                      input.locale === localeRef.current) setLocalError(error);
                });
              }
              catch (error) { setLocalError(error); }
            }}>{t("Preview changes")}</button>
          {preview !== null ? (
            <section aria-live="polite" className="priority-rules-preview">
              <h3>{t("Preview")}</h3>
              <p>{t("Compared with active version")}: {preview.comparedActiveRef.rulesetId}/
                {preview.comparedActiveRef.version}</p>
              <p>{t("Candidate hash")}: <code>{preview.candidate.astHash}</code></p>
              <p>{t("Compared active AST hash")}: <code>{preview.comparedActiveAstHash}</code></p>
              <ul>{preview.compiler.readableRules.map((readable) => {
                const compiled = preview.candidate.additions.find(({ ruleKey }) =>
                  ruleKey === readable.ruleKey);
                const spans = preview.compiler.sourceSpans.find(({ ruleKey }) =>
                  ruleKey === readable.ruleKey);
                return <li key={readable.ruleKey}>
                  <strong>{readable[locale]}</strong>
                  {spans === undefined || preview.candidate.naturalLanguageSource === null
                    ? null : <span>{t("Compiled source")}: <code>{
                      sourceAtCodePointSpan(preview.candidate.naturalLanguageSource, spans.rule)
                    }</code></span>}
                  {compiled === undefined ? null : <>
                    <span>{t("Compiled conditions")}: <code>{JSON.stringify(compiled.when.all)}</code></span>
                    <span>{t("Compiled effects")}: <code>{JSON.stringify(compiled.effect)}</code></span>
                  </>}
                </li>;
              })}</ul>
              <ul>{preview.examples.map((example) => <li key={example.logicalPageId}>
                <strong>{example.display.title ?? t("Untitled")}</strong>
                <span>{example.display.representativeUrl}</span>
                <span>{example.stratum}</span>
              </li>)}</ul>
              <button disabled={!previewIsFresh || previewedDraft === null || lifecycleMutation.isPending} type="button"
                onClick={() => lifecycleMutation.mutate({ kind: "save", draft: previewedDraft!,
                  expectedLatestVersion: rulesState.latestVersion,
                  expectedActiveRef: preview.comparedActiveRef })}>
                {t("Save inactive version")}
              </button>
            </section>
          ) : null}
          {saved?.operation === "save" && canMutateAndRecompute ? (
            <button type="button" onClick={() => setConfirmation({ kind: "activate",
              target: saved.target, expectedActiveRef: saved.activeRef })}>
              {t("Activate saved version")}
            </button>
          ) : null}
          {canMutateAndRecompute ? <div className="priority-rules-lifecycle-actions">
            <button type="button" onClick={() => lifecyclePreviewMutation.mutate({ kind: "disable" })}>{t("Disable")}</button>
            <button type="button" onClick={() => lifecyclePreviewMutation.mutate({ kind: "reset" })}>{t("Reset")}</button>
            <button type="button" onClick={() => recomputeMutation.mutate()}>
              {t("Recompute priority")}
            </button>
          </div> : null}
          <section>
            <h3>{t("Version history")}</h3>
            {rulesState.historyTruncated ? <p>{t("Showing the latest versions only.")}</p> : null}
            <ul>{rulesState.versions.map((version) => <li key={`${version.ref.rulesetId}:${version.ref.version}`}>
              <button type="button" onClick={() => versionMutation.mutate(version.ref)}>
                {t("Version")} {version.ref.version}
              </button>
            </li>)}</ul>
            {selectedVersion !== null ? <div>
              <code>{selectedVersion.astHash}</code>
              {canMutateAndRecompute && !selectedVersion.active ? <button type="button"
                onClick={() => lifecyclePreviewMutation.mutate({ kind: "rollback",
                  version: selectedVersion })}>
                {t("Preview rollback")}
              </button> : null}
            </div> : null}
          </section>
          {confirmation !== null ? <section role="alertdialog" aria-label={t("Confirm rule change")}>
            <p>{t("This changes the active priority rules. Recompute remains a separate action.")}</p>
            <button type="button" onClick={() => lifecycleMutation.mutate(confirmation)}>
              {confirmation.kind === "activate" ? t("Confirm activation") : t("Confirm change")}
            </button>
            <button type="button" onClick={() => setConfirmation(null)}>{t("Cancel")}</button>
          </section> : null}
          {trackedJob !== null ? <p aria-live="polite" role="status">
            {t("Priority recompute")}: {jobQuery.data?.progress.stage ?? trackedJob.status}
          </p> : null}
          {terminalJob !== null ? <p aria-live="polite"
            role={terminalJob.status === "failed" ? "alert" : "status"}>
            {t("Priority recompute finished: {status}", { status: terminalJob.status })}
            {terminalJob.error == null ? null : ` ${errorMessage(terminalJob.error)}`}
          </p> : null}
          {notice !== null ? <p aria-live="polite">{t(notice.key, notice.params)}</p> : null}
          {mutationError !== null && mutationError !== undefined ?
            <p role="alert">
              {mutationErrorSpan === undefined ? null : <span>
                {t("Error at characters {start}-{end}: ", {
                  start: mutationErrorSpan.start,
                  end: mutationErrorSpan.end,
                })}
              </span>}
              {errorMessage(mutationError)}
            </p> : null}
        </>
      ) : null}
    </section>
  );
}
