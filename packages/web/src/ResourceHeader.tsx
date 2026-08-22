import type {
  ActivityRollup,
  ActivityWindow,
  ResourceAlias,
  ResourceDetail,
} from "@tabhub/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState } from "react";

import {
  appendResourceContext,
  changeResource,
  fetchLocalResourceContext,
  fetchResourceActivity,
  fetchResourceDetail,
  fetchResourceOpenTabs,
  setResourceUserEvaluation,
} from "./api";
import { useI18n } from "./i18n";
import { ManualPriorityRating } from "./ManualPriorityRating";
import { LiveResourceResearchPanel } from "./LiveResourceResearchPanel";
import type { ExactTabFallbackRequest } from "./live-acquisition-model";
import { PriorityShadowDetails } from "./PriorityShadow";
import { ResearchHistoryDrawer } from "./ResearchHistoryDrawer";
import { ResearchPanel } from "./ResearchPanel";
import { ResearchPurgeControl } from "./ResearchPurgeControl";
import "./ResourceHeader.css";

function idempotencyKey(prefix: string): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

const RESOURCE_KIND_LABELS: Record<ResourceDetail["resource"]["kind"], string> = {
  website: "Website",
  platform: "Platform",
  collection: "Collection",
};
const RESOURCE_ACCESS_LABELS: Record<ResourceDetail["resource"]["accessClass"], string> = {
  public: "Public",
  authenticated: "Authenticated",
  sensitive: "Sensitive",
};
const CONTEXT_KIND_LABELS = {
  purpose: "Purpose",
  interest: "Interest",
  question: "Question",
  project: "Project",
  next_action: "Next action",
  disposition: "Disposition",
  note: "Note",
} as const;
const ACTIVITY_WINDOW_LABELS: Record<ActivityWindow, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  all: "All time",
};

function editableAliases(detail: ResourceDetail): ResourceAlias[] {
  return detail.aliases
    .filter(({ enabled, provenance }) => enabled && provenance === "user_alias")
    .map(({ hostPattern, matchKind, pathPrefix, priority }) => ({
      hostPattern,
      matchKind,
      pathPrefix,
      priority,
    }));
}

function serializeAliases(detail: ResourceDetail): string {
  return editableAliases(detail)
    .map(({ hostPattern, matchKind, pathPrefix, priority }) =>
      [hostPattern, matchKind, pathPrefix, priority].join(" | "),
    )
    .join("\n");
}

function parseAliases(value: string): ResourceAlias[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hostPattern = "", rawMatch = "exact_host", rawPath = "/", rawPriority = "100"] =
        line.split("|").map((part) => part.trim());
      if (rawMatch !== "exact_host" && rawMatch !== "suffix_host") {
        throw new Error("INVALID_ALIAS");
      }
      const matchKind = rawMatch;
      const priority = Number(rawPriority);
      if (!hostPattern || !Number.isInteger(priority)) throw new Error("INVALID_ALIAS");
      return { hostPattern, matchKind, pathPrefix: rawPath || "/", priority };
    });
}

export function ResourceHeader({
  activityWindowsEnabled = false,
  manualPriorityEnabled = false,
  liveAcquisitionEnabled = false,
  priorityShadowEnabled = false,
  privacyPurgeEnabled = false,
  researchEnabled = false,
  resourceId,
  onLoaded,
}: {
  activityWindowsEnabled?: boolean;
  manualPriorityEnabled?: boolean;
  liveAcquisitionEnabled?: boolean;
  priorityShadowEnabled?: boolean;
  privacyPurgeEnabled?: boolean;
  researchEnabled?: boolean;
  resourceId: number;
  onLoaded?: (resource: { id: number; name: string }) => void;
}) {
  const queryClient = useQueryClient();
  const { errorMessage, formatDate, formatDuration, formatNumber, t } = useI18n();
  const [aliasText, setAliasText] = useState("");
  const [contextKind, setContextKind] = useState<"note" | "next_action">("note");
  const [contextBody, setContextBody] = useState("");
  const [visibility, setVisibility] = useState<"local_only" | "share_with_ai">("local_only");
  const [activityWindow, setActivityWindow] = useState<ActivityWindow>("all");
  const [capturedResearchOpenToken, setCapturedResearchOpenToken] = useState(0);
  const [exactTabFallbackRequest, setExactTabFallbackRequest] =
    useState<ExactTabFallbackRequest | undefined>();
  const aliasHelpId = useId();
  const activityWindowName = useId();
  const detailQuery = useQuery({
    queryKey: ["resource", resourceId],
    queryFn: ({ signal }) => fetchResourceDetail(resourceId, signal),
  });
  const contextQuery = useQuery({
    queryKey: ["resource", resourceId, "local-context"],
    queryFn: ({ signal }) => fetchLocalResourceContext(resourceId, signal),
  });
  const activityQuery = useQuery({
    enabled: activityWindowsEnabled,
    queryKey: ["resource", resourceId, "activity", activityWindow],
    queryFn: ({ signal }) => fetchResourceActivity(resourceId, activityWindow, signal),
  });
  const researchInstancesQuery = useQuery({
    enabled: researchEnabled,
    queryKey: ["tab-instances", "resource-research", resourceId],
    queryFn: ({ signal }) => fetchResourceOpenTabs(resourceId, signal),
    refetchInterval: 15_000,
    refetchOnWindowFocus: "always",
  });
  const detail = detailQuery.data;

  useEffect(() => {
    if (!detail) return;
    setAliasText(serializeAliases(detail));
    onLoaded?.({ id: detail.resource.id, name: detail.resource.name });
  }, [detail, onLoaded]);

  const evaluationMutation = useMutation({
    mutationFn: (evaluation: 1 | 2 | 3 | null) =>
      setResourceUserEvaluation(
        resourceId,
        evaluation,
        idempotencyKey("resource-evaluation"),
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["resource", resourceId] }),
        queryClient.invalidateQueries({ queryKey: ["resources"] }),
      ]);
    },
  });
  const aliasMutation = useMutation({
    mutationFn: async () => {
      if (!detail) throw new Error(t("Resource details are not ready."));
      let aliases: ResourceAlias[];
      try {
        const userAliases = parseAliases(aliasText);
        const protectedAgentAliases = detail.aliases
          .filter(({ enabled, provenance }) => enabled && provenance === "agent_alias")
          .map(({ hostPattern, matchKind, pathPrefix, priority }) => ({
            hostPattern,
            matchKind,
            pathPrefix,
            priority,
          }));
        aliases = [...userAliases, ...protectedAgentAliases];
      } catch {
        throw new Error(t("Each alias must use: host | exact_host or suffix_host | /path | priority"));
      }
      return changeResource({
        kind: "set_aliases",
        resourceId,
        aliases,
        expectedResourceVersion: detail.version,
        expectedRulesetVersion: detail.rulesetVersion,
        idempotencyKey: idempotencyKey("resource-aliases"),
      });
    },
    onSuccess: async () => {
      await Promise.all([
        detailQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["resources"] }),
        queryClient.invalidateQueries({ queryKey: ["tabs"] }),
        queryClient.invalidateQueries({ queryKey: ["tab-instances", "library"] }),
      ]);
    },
    onError: () => void detailQuery.refetch(),
  });
  const contextMutation = useMutation({
    mutationFn: () => appendResourceContext(resourceId, {
      entryKind: contextKind,
      body: contextBody.trim(),
      visibility,
      idempotencyKey: idempotencyKey("resource-context"),
    }),
    onSuccess: async () => {
      setContextBody("");
      await contextQuery.refetch();
    },
  });
  const aliases = useMemo(
    () => detail?.aliases.filter(({ enabled }) => enabled) ?? [],
    [detail?.aliases],
  );

  if (detailQuery.isPending) {
    return <section className="resource-header" role="status">{t("Loading resource details...")}</section>;
  }
  if (detailQuery.isError || !detail) {
    return (
      <section className="resource-header is-error" role="alert">
        <span>{detailQuery.isError ? errorMessage(detailQuery.error) : t("Resource unavailable")}</span>
        <button type="button" onClick={() => void detailQuery.refetch()}>{t("Retry")}</button>
      </section>
    );
  }

  const legacyCoverage = detail.allTimeActivity.coverageStart === null
    ? t("Coverage start unknown")
    : t("Coverage since {date}", {
        date: formatDate(detail.allTimeActivity.coverageStart, { dateStyle: "medium" }),
      });
  const selectedActivity = activityQuery.data?.activity;
  const selectedCoverage = selectedActivity === undefined
    ? undefined
    : selectedActivity.window === "all"
      ? selectedActivity.coverageStart === null
        ? t("Tracking start unknown")
        : t("Tracking since {date}", {
            date: formatDate(selectedActivity.coverageStart, { dateStyle: "medium" }),
          })
      : Date.parse(selectedActivity.coverageStart as string) <=
          Date.parse(selectedActivity.windowStart as string)
        ? t("Full window coverage")
        : t("Partial coverage since {date}", {
            date: formatDate(selectedActivity.coverageStart as string, {
              dateStyle: "medium",
            }),
          });

  return (
    <section className="resource-header" aria-labelledby={`resource-${resourceId}-title`}>
      <div className="resource-header-title">
        <div>
          <p>{t("Selected resource")}</p>
          <h3 id={`resource-${resourceId}-title`}>{detail.resource.name}</h3>
          <span>
            {t(RESOURCE_KIND_LABELS[detail.resource.kind])} / {t(RESOURCE_ACCESS_LABELS[detail.resource.accessClass])}
          </span>
        </div>
        <dl className="resource-counts">
          <div><dt>{t("Logical pages")}</dt><dd>{formatNumber(detail.counts.logicalPageCount)}</dd></div>
          <div><dt>{t("Browser pages")}</dt><dd>{formatNumber(detail.counts.browserPageCount)}</dd></div>
          <div><dt>{t("Physical open copies")}</dt><dd>{formatNumber(detail.counts.physicalOpenCopyCount)}</dd></div>
        </dl>
      </div>

      <ResearchHistoryDrawer
        captureInstances={researchInstancesQuery.data ?? []}
        captureInstancesState={researchInstancesQuery.isPending ? "pending" : researchInstancesQuery.isError ? "error" : "ready"}
        onRetryCaptureInstances={() => void researchInstancesQuery.refetch()}
        privacyPurgeEnabled={privacyPurgeEnabled}
        researchEnabled={researchEnabled}
        target={{ type: "resource", resourceId }}
        onRefresh={async () => {
          await Promise.all([
            detailQuery.refetch(),
            contextQuery.refetch(),
            ...(researchEnabled ? [researchInstancesQuery.refetch()] : []),
          ]);
        }}
      />

      <ResearchPurgeControl
        label={t("Delete this resource's research history")}
        privacyPurgeEnabled={privacyPurgeEnabled}
        target={{ kind: "resource_history", resourceId }}
        onCompleted={() => {
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: ["resource", resourceId] }),
            queryClient.invalidateQueries({ queryKey: ["resources"] }),
            queryClient.invalidateQueries({
              queryKey: ["research-report-history", JSON.stringify({ type: "resource", resourceId })],
            }),
            queryClient.invalidateQueries({ queryKey: ["research-report-detail"] }),
            queryClient.invalidateQueries({ queryKey: ["resource", resourceId, "local-context"] }),
            queryClient.invalidateQueries({ queryKey: ["personal-context"] }),
            queryClient.invalidateQueries({ queryKey: ["research-job"] }),
            queryClient.invalidateQueries({ queryKey: ["live-acquisition-status"] }),
            detailQuery.refetch(),
            contextQuery.refetch(),
            ...(researchEnabled ? [researchInstancesQuery.refetch()] : []),
          ]);
        }}
      />

      {researchEnabled ? (
        <LiveResourceResearchPanel
          onOpenCapturedFallback={(request) => {
            setExactTabFallbackRequest(request);
            setCapturedResearchOpenToken((value) => value + 1);
          }}
          onRefresh={async () => {
            await Promise.all([
              detailQuery.refetch(),
              contextQuery.refetch(),
              researchInstancesQuery.refetch(),
            ]);
          }}
          resourceId={resourceId}
          resourceLabel={detail.resource.name}
          startEnabled={liveAcquisitionEnabled}
        />
      ) : null}

      {researchEnabled ? (
        <ResearchPanel
          captureInstances={researchInstancesQuery.data ?? []}
          captureInstancesState={researchInstancesQuery.isPending ? "pending" : researchInstancesQuery.isError ? "error" : "ready"}
          entryLabel="Research this resource"
          {...(exactTabFallbackRequest === undefined ? {} : { exactTabFallbackRequest })}
          openRequestToken={capturedResearchOpenToken}
          onRetryCaptureInstances={() => void researchInstancesQuery.refetch()}
          target={{ type: "resource", resourceId }}
          onRefresh={async () => {
            await Promise.all([
              detailQuery.refetch(),
              contextQuery.refetch(),
              researchInstancesQuery.refetch(),
            ]);
          }}
        />
      ) : null}

      {activityWindowsEnabled ? (
        <div className="resource-activity-panel">
          <fieldset className="resource-activity-windows">
            <legend>{t("Activity period")}</legend>
            {(["7d", "30d", "all"] as const).map((window) => (
              <label key={window}>
                <input
                  checked={activityWindow === window}
                  name={activityWindowName}
                  type="radio"
                  value={window}
                  onChange={() => setActivityWindow(window)}
                />
                <span>{t(ACTIVITY_WINDOW_LABELS[window])}</span>
              </label>
            ))}
          </fieldset>
          <div
            aria-atomic="true"
            aria-busy={activityQuery.isPending || activityQuery.isFetching}
            aria-live="polite"
            className="resource-activity-summary"
          >
            <strong>{t("Activity for selected period")}</strong>
            {selectedActivity === undefined ? (
              activityQuery.isError ? null : <span role="status">{t("Loading activity...")}</span>
            ) : (
              <>
                <span>{t("On screen: {duration}", { duration: formatDuration(selectedActivity.onScreenMs) })}</span>
                <span>{t("Active use: {duration}", { duration: formatDuration(selectedActivity.activeUseMs) })}</span>
                <small>{selectedCoverage}</small>
              </>
            )}
            {activityQuery.isFetching && selectedActivity !== undefined ? (
              <small role="status">{t("Updating activity...")}</small>
            ) : null}
            {activityQuery.isError ? (
              <span className="resource-activity-error" role="alert">
                {t("Activity unavailable")}
                <button type="button" onClick={() => void activityQuery.refetch()}>
                  {t("Retry activity")}
                </button>
              </span>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="resource-activity-summary">
          <strong>{t("All-time activity")}</strong>
          <span>{t("On screen: {duration}", { duration: formatDuration(detail.allTimeActivity.onScreenMs) })}</span>
          <span>{t("Active use: {duration}", { duration: formatDuration(detail.allTimeActivity.activeUseMs) })}</span>
          <small>{legacyCoverage}</small>
        </div>
      )}

      <div className="resource-header-editors">
        <fieldset>
          <legend>{t("Your evaluation")}</legend>
          {manualPriorityEnabled ? (
            <ManualPriorityRating
              busy={evaluationMutation.isPending}
              labels={{
                group: t("Personal rating"),
                clear: t("Clear"),
                level: (value) => t("Set evaluation to {level} of 3", { level: value }),
              }}
              value={detail.preference.userEvaluation as 1 | 2 | 3 | null}
              onChange={(value) => evaluationMutation.mutate(value)}
            />
          ) : null}
          <p>
            {detail.preference.provenance === null
              ? t("No personal evaluation yet.")
              : detail.preference.provenance.actor === "user"
                ? t("Set manually by you on {date}.", {
                    date: formatDate(detail.preference.updatedAt, { dateStyle: "medium" }),
                  })
                : t("Recorded by an agent on your behalf on {date}.", {
                    date: formatDate(detail.preference.updatedAt, { dateStyle: "medium" }),
                  })}
          </p>
          {priorityShadowEnabled ? (
            <PriorityShadowDetails
              enabled
              subject={{ type: "resource", resourceId }}
              userImportance={detail.preference.userEvaluation as 1 | 2 | 3 | null}
            />
          ) : (
            <p><strong>{t("AI assessment")}</strong>: {t("Not available yet")}</p>
          )}
          {evaluationMutation.isError ? <p role="alert">{errorMessage(evaluationMutation.error)}</p> : null}
        </fieldset>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            aliasMutation.mutate();
          }}
        >
          <strong>{t("Aliases")}</strong>
          <p>{t("System and agent aliases remain protected. Edit only user aliases below.")}</p>
          <textarea
            aria-describedby={aliasHelpId}
            aria-label={t("Editable resource aliases")}
            rows={Math.max(2, aliasText.split("\n").length)}
            value={aliasText}
            onChange={(event) => setAliasText(event.target.value)}
          />
          <small id={aliasHelpId}>{t("One per line: host | exact_host or suffix_host | /path | priority")}</small>
          {aliases.some(({ provenance }) => provenance !== "user_alias") ? (
            <small>{t("Protected aliases: {aliases}", {
              aliases: aliases
                .filter(({ provenance }) => provenance !== "user_alias")
                .map(({ hostPattern }) => hostPattern)
                .join(", "),
            })}</small>
          ) : null}
          <button disabled={aliasMutation.isPending} type="submit">{t("Save aliases")}</button>
          {aliasMutation.isError ? <span role="alert">{errorMessage(aliasMutation.error)}</span> : null}
          {aliasMutation.isSuccess ? <span role="status">{t("Aliases saved")}</span> : null}
        </form>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (contextBody.trim()) contextMutation.mutate();
          }}
        >
          <strong>{t("Resource context")}</strong>
          <div className="resource-context-options">
            <label>
              <span>{t("Context kind")}</span>
              <select value={contextKind} onChange={(event) => setContextKind(event.target.value as "note" | "next_action") }>
                <option value="note">{t("Note")}</option>
                <option value="next_action">{t("Next action")}</option>
              </select>
            </label>
            <label>
              <span>{t("Visibility")}</span>
              <select value={visibility} onChange={(event) => setVisibility(event.target.value as "local_only" | "share_with_ai") }>
                <option value="local_only">{t("Local only")}</option>
                <option value="share_with_ai">{t("May be used by AI")}</option>
              </select>
            </label>
          </div>
          <textarea
            aria-label={t("Resource note or next action")}
            maxLength={100_000}
            placeholder={contextKind === "note" ? t("Why is this resource useful?") : t("What should happen next?")}
            value={contextBody}
            onChange={(event) => setContextBody(event.target.value)}
          />
          <button disabled={!contextBody.trim() || contextMutation.isPending} type="submit">{t("Save context")}</button>
          {contextMutation.isError ? <span role="alert">{errorMessage(contextMutation.error)}</span> : null}
          {contextQuery.isPending ? <span role="status">{t("Loading resource context...")}</span> : null}
          {contextQuery.isError ? <span role="alert">{errorMessage(contextQuery.error)}</span> : null}
          {contextQuery.data?.context.currentEntries.length ? (
            <ul className="resource-context-list">
              {contextQuery.data.context.currentEntries.map((entry) => (
                <li key={entry.id}>
                  <strong>{t(CONTEXT_KIND_LABELS[entry.entryKind])}</strong>
                  <span>{entry.body}</span>
                  <small>{entry.visibility === "local_only" ? t("Local only") : t("May be used by AI")}</small>
                </li>
              ))}
            </ul>
          ) : contextQuery.isSuccess ? <p>{t("No resource context yet.")}</p> : null}
        </form>
      </div>
    </section>
  );
}
