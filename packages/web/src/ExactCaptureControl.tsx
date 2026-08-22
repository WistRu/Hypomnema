import {
  type ExactInstanceCaptureFailureCode,
  type ExactInstanceCaptureReceipt,
  type TabDetailResponse,
  type TabInstance,
} from "@tabhub/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  TabCommandRelayClientError,
  executeRelayedTabCommand,
  fetchConnectedTabCommandScopes,
  isRelayedTabCommandOutcomeUnknown,
} from "./api";
import {
  classifyExactCaptureCopies,
  executeExactInstanceCapture,
  resolveExactCaptureSelection,
  type ExactCaptureCopy,
  type ExactCaptureUnavailableReason,
  type SelectableExactCaptureCopy,
} from "./exact-instance-capture";
import { createWindowExtensionBridge } from "./extension-bridge";
import { useI18n } from "./i18n";

type CaptureState =
  | { kind: "idle" }
  | { kind: "stale" }
  | { kind: "captured"; receipt: ExactInstanceCaptureReceipt }
  | { code: ExactInstanceCaptureFailureCode; kind: "failed" }
  | { kind: "unknown" }
  | { kind: "unknown-reconciled"; contentRevision: number }
  | { kind: "unknown-unchanged" }
  | { kind: "offline" }
  | { kind: "protocol-unsupported" }
  | { kind: "feature-unavailable" }
  | { kind: "refresh-error" };

export interface ExactCaptureReconciliation {
  contentRevision: number;
  previousContentRevision: number | null;
}

interface ExactCaptureControlProps {
  actionLabel?: string;
  actionPendingLabel?: string;
  canonicalTabId: number;
  detail: Pick<TabDetailResponse, "id" | "content">;
  externalBusy?: boolean;
  instances: readonly TabInstance[];
  instancesPending: boolean;
  onCaptured?: (receipt: ExactInstanceCaptureReceipt) => void;
  onCaptureFailed?: () => void;
  onCaptureReconciled?: (reconciliation: ExactCaptureReconciliation) => void;
  onCaptureStarted?: () => void;
  onCaptureUnknown?: () => void;
  onCaptureUnchanged?: () => void;
  refetchInstances: () => Promise<{
    data: readonly TabInstance[] | undefined;
    isError: boolean;
  }>;
  refetchTabDetail: () => Promise<{
    data: Pick<TabDetailResponse, "id" | "content"> | undefined;
    isError: boolean;
  }>;
}

function unavailableMessage(
  reason: ExactCaptureUnavailableReason,
  t: ReturnType<typeof useI18n>["t"],
): string {
  switch (reason) {
    case "extension_offline":
      return t("This browser session is offline.");
    case "protocol_unsupported":
      return t("Reload the updated extension in this browser.");
    case "incomplete_identity":
      return t("This copy has incomplete browser identity.");
    case "page_unsupported":
      return t("This page type cannot be captured.");
    case "discarded":
      return t("This copy is discarded; activate it before capture.");
  }
}

function failureMessage(
  code: ExactInstanceCaptureFailureCode,
  t: ReturnType<typeof useI18n>["t"],
): string {
  switch (code) {
    case "CAPTURE_INSTANCE_MISSING":
    case "CAPTURE_TAB_CLOSED":
      return t("The selected copy was closed. Refresh open copies.");
    case "CAPTURE_TAB_NAVIGATED":
      return t("The selected copy navigated. Refresh it before capturing.");
    case "CAPTURE_INSTANCE_STALE":
    case "CAPTURE_SCOPE_MISMATCH":
      return t("The selected copy changed. Refresh and select it again.");
    case "CAPTURE_PAGE_UNSUPPORTED":
      return t("This page type cannot be captured.");
    case "CAPTURE_EXTRACTION_FAILED":
      return t("TabHub could not extract readable page content.");
    case "CAPTURE_INGEST_UNAVAILABLE":
      return t("The captured content could not reach TabHub.");
    case "CAPTURE_INGEST_REJECTED":
    case "CAPTURE_COMMAND_MISMATCH":
    case "CAPTURE_COMMAND_NOT_ACTIVE":
      return t("TabHub rejected this capture. Refresh and select the copy again.");
  }
}

function copyLabel(
  copy: ExactCaptureCopy,
  formatNumber: ReturnType<typeof useI18n>["formatNumber"],
  t: ReturnType<typeof useI18n>["t"],
): string {
  const tabId = copy.instance.browserTabId === null
    ? t("unknown tab")
    : formatNumber(copy.instance.browserTabId);
  return t("{browser}, window {windowId}, tab {tabId}, installation {installation}", {
    browser: copy.instance.browser,
    installation: copy.instance.installationId.slice(0, 8),
    tabId,
    windowId: formatNumber(copy.instance.windowId),
  });
}

function instanceSetSignature(instances: readonly TabInstance[]): string {
  return JSON.stringify(
    instances.map((instance) => [
      instance.canonicalTabId,
      instance.instanceId,
      instance.browser,
      instance.installationId,
      instance.browserSessionId,
      instance.browserTabId,
      instance.url,
      instance.instanceRevision,
      instance.firstSeenAt,
      instance.discarded,
    ]),
  );
}

function scopeSetSignature(
  scopes: readonly {
    browser: string;
    browserSessionId: string;
    installationId: string;
    protocolVersion: number;
  }[],
): string {
  return JSON.stringify(
    scopes.map((scope) => [
      scope.browser,
      scope.installationId,
      scope.browserSessionId,
      scope.protocolVersion,
    ]),
  );
}

function detailSignature(
  detail: Pick<TabDetailResponse, "id" | "content">,
): string {
  return JSON.stringify([detail.id, detail.content?.contentRevision ?? null]);
}

export function ExactCaptureControl({
  actionLabel,
  actionPendingLabel,
  canonicalTabId,
  detail,
  externalBusy = false,
  instances,
  instancesPending,
  onCaptured,
  onCaptureFailed,
  onCaptureReconciled,
  onCaptureStarted,
  onCaptureUnchanged,
  onCaptureUnknown,
  refetchInstances,
  refetchTabDetail,
}: ExactCaptureControlProps) {
  const queryClient = useQueryClient();
  const { formatNumber, t } = useI18n();
  const bridge = useMemo(
    () =>
      typeof window === "undefined" ? null : createWindowExtensionBridge(),
    [],
  );
  const probeQuery = useQuery({
    queryKey: ["extension-bridge", "probe"],
    queryFn: () => bridge!.probe(),
    enabled: bridge !== null,
    refetchOnWindowFocus: "always",
    staleTime: 5_000,
  });
  const scopesQuery = useQuery({
    queryKey: ["tab-command-relay", "scopes"],
    queryFn: ({ signal }) => fetchConnectedTabCommandScopes(signal),
    refetchInterval: 10_000,
    refetchOnWindowFocus: "always",
  });
  const copies = useMemo(
    () =>
      classifyExactCaptureCopies(
        instances,
        probeQuery.data,
        scopesQuery.data ?? [],
      ),
    [instances, probeQuery.data, scopesQuery.data],
  );
  const [selectedSnapshotKey, setSelectedSnapshotKey] = useState<string | null>(
    null,
  );
  const [selectionBlockedAfterDrift, setSelectionBlockedAfterDrift] =
    useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [awaitingFreshObservation, setAwaitingFreshObservation] = useState<{
    detail: string;
    instances: string;
    reconciliation: ExactCaptureReconciliation | null;
    scopes: string;
    unknownUnchanged: boolean;
  } | null>(null);
  const [state, setState] = useState<CaptureState>({ kind: "idle" });
  const captureDispatchInFlight = useRef(false);
  const captureAttempt = useRef<{
    id: number;
    outcome: "dispatching" | "unknown";
    previousContentRevision: number | null;
  } | null>(null);
  const captureAttemptSequence = useRef(0);
  const mounted = useRef(true);
  const selected = resolveExactCaptureSelection(selectedSnapshotKey, copies);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (
      awaitingFreshObservation === null ||
      detailSignature(detail) !== awaitingFreshObservation.detail ||
      instanceSetSignature(instances) !== awaitingFreshObservation.instances ||
      scopeSetSignature(scopesQuery.data ?? []) !== awaitingFreshObservation.scopes
    ) {
      return;
    }
    setAwaitingFreshObservation(null);
    setRefreshing(false);
    setSelectionBlockedAfterDrift(false);
    if (awaitingFreshObservation.reconciliation !== null) {
      captureAttempt.current = null;
      setState({
        kind: "unknown-reconciled",
        contentRevision: awaitingFreshObservation.reconciliation.contentRevision,
      });
      onCaptureReconciled?.(awaitingFreshObservation.reconciliation);
    } else if (awaitingFreshObservation.unknownUnchanged) {
      captureAttempt.current = null;
      setState({ kind: "unknown-unchanged" });
      onCaptureUnchanged?.();
    }
  }, [
    awaitingFreshObservation,
    detail,
    instances,
    onCaptureReconciled,
    onCaptureUnchanged,
    scopesQuery.data,
  ]);

  useEffect(() => {
    if (instancesPending || scopesQuery.isPending || refreshing) return;
    if (selectedSnapshotKey !== null && selected === undefined) {
      setSelectedSnapshotKey(null);
      setSelectionBlockedAfterDrift(true);
      setState({ kind: "stale" });
      return;
    }
    if (
      selectedSnapshotKey === null &&
      !selectionBlockedAfterDrift &&
      state.kind === "idle" &&
      instances.length === 1 &&
      copies[0]?.kind === "selectable"
    ) {
      setSelectedSnapshotKey(copies[0].selectionKey);
    }
  }, [
    copies,
    instances.length,
    instancesPending,
    scopesQuery.isPending,
    refreshing,
    selected,
    selectedSnapshotKey,
    selectionBlockedAfterDrift,
    state.kind,
  ]);

  const captureMutation = useMutation({
    mutationFn: ({ selection }: {
      previousContentRevision: number | null;
      selection: SelectableExactCaptureCopy;
    }) => executeExactInstanceCapture(selection, executeRelayedTabCommand),
    onError: (error) => {
      if (!mounted.current) return;
      setSelectionBlockedAfterDrift(true);
      setSelectedSnapshotKey(null);
      if (error instanceof TabCommandRelayClientError) {
        if (error.code === "SCOPE_OFFLINE") {
          setState({ kind: "offline" });
          onCaptureFailed?.();
          return;
        }
        if (error.code === "EXTENSION_PROTOCOL_UNSUPPORTED") {
          setState({ kind: "protocol-unsupported" });
          onCaptureFailed?.();
          return;
        }
        if (error.code === "PAGE_SUMMARY_CAPTURE_UNAVAILABLE") {
          setState({ kind: "feature-unavailable" });
          onCaptureFailed?.();
          void queryClient.invalidateQueries({ queryKey: ["features"] });
          return;
        }
      }
      if (isRelayedTabCommandOutcomeUnknown(error)) {
        if (captureAttempt.current !== null) {
          captureAttempt.current = {
            ...captureAttempt.current,
            outcome: "unknown",
          };
        }
        setState({ kind: "unknown" });
        onCaptureUnknown?.();
      } else {
        setState({ kind: "refresh-error" });
        onCaptureFailed?.();
      }
    },
    onSuccess: (outcome) => {
      if (!mounted.current) return;
      if (outcome === undefined) return;
      captureAttempt.current = null;
      if (outcome.status === "failed") {
        setSelectionBlockedAfterDrift(true);
        setSelectedSnapshotKey(null);
        setState({ code: outcome.failure.code, kind: "failed" });
        onCaptureFailed?.();
        return;
      }
      setState({ kind: "captured", receipt: outcome.receipt });
      onCaptured?.(outcome.receipt);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tab", outcome.receipt.canonicalTabId] }),
        queryClient.invalidateQueries({ queryKey: ["tabs"] }),
        queryClient.invalidateQueries({ queryKey: ["tab-instances"] }),
      ]);
    },
    onSettled: () => {
      captureDispatchInFlight.current = false;
    },
  });

  const refresh = async () => {
    const unknownCaptureAttempt =
      captureAttempt.current?.outcome === "unknown"
        ? captureAttempt.current
        : null;
    setSelectedSnapshotKey(null);
    setSelectionBlockedAfterDrift(true);
    setRefreshing(true);
    setAwaitingFreshObservation(null);
    setState({ kind: "idle" });
    const refreshed = await Promise.allSettled([
      refetchInstances(),
      refetchTabDetail(),
      scopesQuery.refetch(),
    ]);
    // The page bridge is not capture authority. Refresh it for neighboring
    // browser controls, but do not block REST relay capture if it is absent.
    void probeQuery.refetch();
    const failed = refreshed.some(
      (result) =>
        result.status === "rejected" ||
        (result.status === "fulfilled" &&
          typeof result.value === "object" &&
          result.value !== null &&
          "isError" in result.value &&
          result.value.isError === true),
    );
    if (failed) {
      setRefreshing(false);
      setState({ kind: "refresh-error" });
      return;
    }
    const instancesResult = refreshed[0];
    const detailResult = refreshed[1];
    const scopesResult = refreshed[2];
    const freshInstances =
      instancesResult?.status === "fulfilled" &&
      Array.isArray(instancesResult.value.data)
        ? instancesResult.value.data
        : undefined;
    const freshScopes =
      scopesResult?.status === "fulfilled" &&
      typeof scopesResult.value === "object" &&
      scopesResult.value !== null &&
      "data" in scopesResult.value &&
      Array.isArray(scopesResult.value.data)
        ? scopesResult.value.data
        : undefined;
    const freshDetail =
      detailResult?.status === "fulfilled" &&
      typeof detailResult.value === "object" &&
      detailResult.value !== null &&
      "data" in detailResult.value
        ? detailResult.value.data as Pick<TabDetailResponse, "id" | "content"> | undefined
        : undefined;
    if (
      freshInstances === undefined ||
      freshInstances.some(({ canonicalTabId: id }) => id !== canonicalTabId) ||
      freshScopes === undefined ||
      freshDetail === undefined ||
      freshDetail.id !== canonicalTabId
    ) {
      setRefreshing(false);
      setState({ kind: "refresh-error" });
      return;
    }
    const expectedObservation = {
      detail: detailSignature(freshDetail),
      instances: instanceSetSignature(freshInstances),
      reconciliation: null as ExactCaptureReconciliation | null,
      scopes: scopeSetSignature(freshScopes),
      unknownUnchanged: false,
    };
    if (unknownCaptureAttempt !== null) {
      const previousContentRevision =
        unknownCaptureAttempt.previousContentRevision;
      const currentContentRevision = freshDetail.content?.contentRevision;
      if (
        currentContentRevision !== undefined &&
        (previousContentRevision === null || currentContentRevision > previousContentRevision)
      ) {
        expectedObservation.reconciliation = {
          contentRevision: currentContentRevision,
          previousContentRevision,
        };
      } else {
        expectedObservation.unknownUnchanged = true;
      }
    }
    if (
      instanceSetSignature(instances) === expectedObservation.instances &&
      detailSignature(detail) === expectedObservation.detail &&
      scopeSetSignature(scopesQuery.data ?? []) === expectedObservation.scopes
    ) {
      setRefreshing(false);
      setSelectionBlockedAfterDrift(false);
      if (expectedObservation.reconciliation !== null) {
        if (captureAttempt.current?.id === unknownCaptureAttempt?.id) {
          captureAttempt.current = null;
        }
        setState({
          kind: "unknown-reconciled",
          contentRevision: expectedObservation.reconciliation.contentRevision,
        });
        onCaptureReconciled?.(expectedObservation.reconciliation);
      } else if (expectedObservation.unknownUnchanged) {
        if (captureAttempt.current?.id === unknownCaptureAttempt?.id) {
          captureAttempt.current = null;
        }
        setState({ kind: "unknown-unchanged" });
        onCaptureUnchanged?.();
      }
      return;
    }
    setAwaitingFreshObservation(expectedObservation);
  };

  const feedback = (() => {
    if (state.kind === "captured") {
      return t("Page captured as content revision {revision}.", {
        revision: formatNumber(state.receipt.contentRevision),
      });
    }
    if (state.kind === "failed") return failureMessage(state.code, t);
    if (state.kind === "unknown") {
      return t("Capture outcome is unknown. Refresh before taking another action.");
    }
    if (state.kind === "unknown-reconciled") {
      return t("The refreshed page shows captured content revision {revision}. Continue with the summary without capturing again.", {
        revision: formatNumber(state.contentRevision),
      });
    }
    if (state.kind === "unknown-unchanged") {
      return t("The refreshed page does not show a new capture. Select an open copy before trying again.");
    }
    if (state.kind === "offline") {
      return t("This browser session went offline. Refresh copies.");
    }
    if (state.kind === "protocol-unsupported") {
      return t("Reload the updated extension, then refresh copies.");
    }
    if (state.kind === "feature-unavailable") {
      return t("Page-summary capture was disabled while this action was starting. TabHub is refreshing feature settings.");
    }
    if (state.kind === "stale") {
      return t("The selected copy changed. Refresh and select it again.");
    }
    if (state.kind === "refresh-error") {
      return t("TabHub could not refresh capture availability.");
    }
    return null;
  })();

  return (
    <div className="exact-capture-control">
      <p className="muted-copy">
        {t("Capture one exact open copy before creating a fresh summary.")}
      </p>
      {instancesPending || scopesQuery.isPending || probeQuery.isPending || refreshing ? (
        <p role="status">{t("Checking capture availability...")}</p>
      ) : null}
      {!instancesPending && instances.length === 0 ? (
        <p className="muted-copy">{t("Open this page in a connected browser to capture it.")}</p>
      ) : null}
      {instances.length > 0 ? (
        <fieldset className="exact-capture-copies">
          <legend>{t("Open copy to capture")}</legend>
          {copies.map((copy) => {
            const label = copyLabel(copy, formatNumber, t);
            return (
              <label key={copy.selectionKey}>
                <input
                  checked={selectedSnapshotKey === copy.selectionKey}
                  disabled={
                    copy.kind === "unavailable" ||
                    captureMutation.isPending ||
                    externalBusy ||
                    selectionBlockedAfterDrift ||
                    refreshing
                  }
                  name="exact-capture-copy"
                  type="radio"
                  value={copy.selectionKey}
                  onChange={() => {
                    setSelectedSnapshotKey(copy.selectionKey);
                    setState({ kind: "idle" });
                  }}
                />
                <span>
                  <strong>{label}</strong>
                  {copy.kind === "unavailable" ? (
                    <small>{unavailableMessage(copy.reason, t)}</small>
                  ) : null}
                </span>
              </label>
            );
          })}
        </fieldset>
      ) : null}
      <div className="exact-capture-actions">
        <button
          disabled={
            selected === undefined ||
            captureMutation.isPending ||
            externalBusy ||
            refreshing ||
            state.kind === "unknown-reconciled" ||
            state.kind === "feature-unavailable"
          }
          type="button"
          onClick={() => {
            if (captureDispatchInFlight.current || selected === undefined) return;
            captureDispatchInFlight.current = true;
            const previousContentRevision =
              detail.content?.contentRevision ?? null;
            captureAttempt.current = {
              id: ++captureAttemptSequence.current,
              outcome: "dispatching",
              previousContentRevision,
            };
            setState({ kind: "idle" });
            onCaptureStarted?.();
            captureMutation.mutate({
              previousContentRevision,
              selection: selected,
            });
          }}
        >
          {captureMutation.isPending
            ? actionPendingLabel ?? t("Capturing page...")
            : actionLabel ?? t("Capture page")}
        </button>
        <button
          disabled={
            captureMutation.isPending || externalBusy || refreshing
          }
          type="button"
          onClick={() => void refresh()}
        >
          {t("Refresh copies")}
        </button>
      </div>
      {feedback ? (
        <p
          role={
            state.kind === "captured" || state.kind === "unknown-reconciled"
              ? "status"
              : "alert"
          }
        >
          {feedback}
        </p>
      ) : null}
      {scopesQuery.isError ? (
        <p role="alert">{t("TabHub could not check connected browser sessions.")}</p>
      ) : null}
    </div>
  );
}
