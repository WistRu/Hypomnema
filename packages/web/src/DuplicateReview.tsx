import type { DuplicateGroup } from "@tabhub/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fetchDuplicateGroups } from "./api";
import {
  buildCloseConfirmation,
  duplicateGroupView,
  duplicateReviewSummary,
} from "./duplicate-model";
import {
  createWindowExtensionBridge,
  ExtensionBridgeError,
  type DuplicateClosePreview,
  type DuplicateCloseResult,
} from "./extension-bridge";
import { clampPage } from "./pagination";
import {
  activateModalDialog,
  shouldDismissAfterConfirmedAction,
} from "./modal-dialog";

const BROWSER_LABELS: Record<string, string> = {
  chrome: "Chrome",
  edge: "Edge",
  other: "Other",
  yandex: "Yandex",
};

function browserLabel(browser: string | null): string {
  if (browser === null) return "this browser";
  return BROWSER_LABELS[browser] ?? browser;
}

function groupTitle(group: DuplicateGroup): string {
  return group.instances.find((instance) => instance.title?.trim())?.title?.trim() ??
    group.url;
}

function instanceDisposition(group: DuplicateGroup, instanceId: number): string {
  if (instanceId === group.keeperInstanceId) return "Keep";
  if (group.protectedInstanceIds.includes(instanceId)) return "Protected";
  if (group.candidateInstanceIds.includes(instanceId)) return "Can close";
  return "Keep";
}

interface PreviewRequest {
  urls?: string[];
}

interface PendingConfirmation {
  preview: DuplicateClosePreview;
}

export function DuplicateReview({
  browser,
  onCollectionChanged,
}: {
  browser: string;
  onCollectionChanged: () => Promise<void>;
}) {
  const bridge = useMemo(() => createWindowExtensionBridge(), []);
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(1);
  const [pendingConfirmation, setPendingConfirmation] =
    useState<PendingConfirmation | null>(null);
  const [closeResult, setCloseResult] = useState<DuplicateCloseResult | null>(null);
  const [closeRequested, setCloseRequested] = useState(false);
  const confirmationDialogRef = useRef<HTMLElement>(null);
  const confirmationTriggerRef = useRef<HTMLElement | null>(null);
  const closeResultRef = useRef<HTMLParagraphElement>(null);
  const closePendingRef = useRef(false);
  const dismissConfirmation = useCallback(() => {
    if (closePendingRef.current) return;
    setCloseRequested(false);
    setPendingConfirmation(null);
  }, []);
  const probeQuery = useQuery({
    queryKey: ["extension-bridge", "probe"],
    queryFn: () => bridge.probe(),
    retry: false,
    refetchOnWindowFocus: "always",
    staleTime: 10_000,
  });
  const groupsQuery = useQuery({
    queryKey: ["duplicate-groups", { browser, page }],
    queryFn: ({ signal }) => fetchDuplicateGroups({ browser, page }, signal),
    refetchInterval: 15_000,
  });
  const connectedInstallationId =
    probeQuery.data?.available === true ? probeQuery.data.installationId : null;
  const connectedBrowser =
    probeQuery.data?.available === true ? probeQuery.data.browser : null;
  const controlledInstallationId =
    connectedBrowser === null ? null : connectedInstallationId;
  const summary = groupsQuery.data
    ? duplicateReviewSummary(groupsQuery.data, controlledInstallationId)
    : null;
  const pagePlan = groupsQuery.data
    ? buildCloseConfirmation(groupsQuery.data.items, controlledInstallationId)
    : null;
  const selectedBrowserControlled =
    connectedInstallationId !== null &&
    connectedBrowser !== null &&
    (browser === "all" || browser === connectedBrowser);

  useEffect(() => {
    setPage(1);
    setCloseRequested(false);
    setPendingConfirmation(null);
    setCloseResult(null);
  }, [browser]);
  useEffect(() => {
    if (groupsQuery.data === undefined) return;
    setPage((current) =>
      clampPage(
        current,
        groupsQuery.data!.totalGroups,
        groupsQuery.data!.pageSize,
      ),
    );
  }, [groupsQuery.data?.pageSize, groupsQuery.data?.totalGroups]);
  useEffect(() => {
    const dialog = confirmationDialogRef.current;
    if (pendingConfirmation === null || dialog === null) return;

    return activateModalDialog(
      dialog,
      confirmationTriggerRef.current,
      dismissConfirmation,
      () => closeResultRef.current,
    );
  }, [dismissConfirmation, pendingConfirmation]);

  const previewMutation = useMutation({
    mutationFn: async ({ urls }: PreviewRequest) => {
      const preview = await bridge.preview(urls);
      if (
        connectedInstallationId === null ||
        connectedBrowser === null ||
        preview.installationId !== connectedInstallationId ||
        preview.browser !== connectedBrowser
      ) {
        throw new ExtensionBridgeError(
          "The connected extension installation changed. Refresh this page before closing tabs.",
        );
      }
      return { preview };
    },
    onSuccess: ({ preview }) => {
      setCloseResult(null);
      setCloseRequested(false);
      if (preview.totalCloseCandidates === 0) {
        setPendingConfirmation(null);
        return;
      }
      setPendingConfirmation({ preview });
    },
  });
  const closeMutation = useMutation({
    mutationFn: async (request: PendingConfirmation) => {
      const result = await bridge.close(request.preview.previewId);
      if (
        result.installationId !== request.preview.installationId ||
        result.browser !== request.preview.browser
      ) {
        throw new ExtensionBridgeError(
          "The extension installation changed while closing duplicates.",
        );
      }
      return result;
    },
    onSuccess: async (result) => {
      setCloseResult(result);
      await Promise.all([groupsQuery.refetch(), onCollectionChanged()]);
    },
  });
  closePendingRef.current = closeMutation.isPending;
  useEffect(() => {
    if (
      !shouldDismissAfterConfirmedAction(closeRequested, closeMutation.status)
    ) {
      return;
    }
    setCloseRequested(false);
    setPendingConfirmation(null);
  }, [closeMutation.status, closeRequested]);
  const actionError = previewMutation.error ?? closeMutation.error;
  const totalPages = groupsQuery.data
    ? Math.max(1, Math.ceil(groupsQuery.data.totalGroups / groupsQuery.data.pageSize))
    : 1;

  return (
    <section className="duplicate-review" aria-labelledby="duplicate-review-title">
      <div className="duplicate-summary-row">
        <div>
          <p>Safe cleanup</p>
          <h3 id="duplicate-review-title">Exact URL duplicates</h3>
          <span>
            Only byte-for-byte matching URLs in one browser installation are grouped.
            URL variants are never auto-closed.
          </span>
        </div>
        {summary ? (
          <dl className="duplicate-metrics">
            <div>
              <dt>Groups</dt>
              <dd>{summary.exactGroups.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Tabs in groups</dt>
              <dd>{summary.physicalTabs.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Extra copies</dt>
              <dd>{summary.duplicateCopies.toLocaleString()}</dd>
            </div>
            <div>
              <dt>All-install snapshot candidates</dt>
              <dd>{summary.allInstallationCandidates.toLocaleString()}</dd>
            </div>
            <div>
              <dt>This install</dt>
              <dd>Live preview</dd>
            </div>
          </dl>
        ) : null}
        <div className="duplicate-summary-actions">
          <button
            className="secondary-action"
            disabled={groupsQuery.isPending || groupsQuery.data?.totalGroups === 0}
            type="button"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "Hide review" : "Review exact duplicates"}
          </button>
          <button
            className="danger-action"
            disabled={
              !selectedBrowserControlled ||
              groupsQuery.data?.totalGroups === 0 ||
              previewMutation.isPending ||
              closeMutation.isPending
            }
            title={
              selectedBrowserControlled
                ? "The extension will re-check every tab before closing it."
                : "Open this TabHub page in the browser whose duplicates you want to close."
            }
            type="button"
            onClick={(event) => {
              confirmationTriggerRef.current = event.currentTarget;
              previewMutation.mutate({});
            }}
          >
            {previewMutation.isPending
              ? "Checking current tabs..."
              : "Preview this installation"}
          </button>
        </div>
      </div>

      <div className="bridge-status" role="status">
        {probeQuery.isPending ? (
          "Checking for the local TabHub extension..."
        ) : probeQuery.data?.available && probeQuery.data.browser !== null ? (
          <>
            <span className="is-connected" aria-hidden="true" />
            Connected to {browserLabel(probeQuery.data.browser)}. Only this installation
            can be controlled from this page.
          </>
        ) : probeQuery.data?.available ? (
          <>
            <span aria-hidden="true" />
            Extension found, but its browser identity is not configured. Choose the
            browser in the extension options before closing duplicates.
          </>
        ) : (
          <>
            <span aria-hidden="true" />
            Extension bridge unavailable. Open or refresh TabHub in a browser with the
            updated extension to close duplicates.
          </>
        )}
        <button
          disabled={probeQuery.isFetching}
          type="button"
          onClick={() => void probeQuery.refetch()}
        >
          {probeQuery.isFetching ? "Re-checking..." : "Re-check extension"}
        </button>
      </div>

      {previewMutation.isSuccess &&
      previewMutation.data.preview.totalCloseCandidates === 0 ? (
        <p className="duplicate-action-result" role="status">
          Nothing can be safely closed now. Active and pinned copies were preserved.
        </p>
      ) : null}
      {closeResult ? (
        <p
          className="duplicate-action-result"
          ref={closeResultRef}
          role="status"
          tabIndex={-1}
        >
          Closed {closeResult.closed.toLocaleString()}; skipped{" "}
          {closeResult.skipped.toLocaleString()}; failed{" "}
          {closeResult.failed.toLocaleString()}.
        </p>
      ) : null}
      {actionError ? (
        <p className="duplicate-action-error" role="alert">
          {actionError.message}
        </p>
      ) : null}

      {expanded ? (
        <div className="duplicate-groups">
          {groupsQuery.isPending ? (
            <p className="duplicate-state" role="status">Loading exact duplicate groups...</p>
          ) : null}
          {groupsQuery.isError ? (
            <div className="duplicate-state is-error" role="alert">
              <span>{groupsQuery.error.message}</span>
              <button type="button" onClick={() => void groupsQuery.refetch()}>
                Retry
              </button>
            </div>
          ) : null}
          {groupsQuery.data?.items.map((group) => {
            const view = duplicateGroupView(group, controlledInstallationId);
            return (
              <article className="duplicate-group" key={`${group.installationId}\n${group.url}`}>
                <header>
                  <div>
                    <h4>{groupTitle(group)}</h4>
                    <a href={group.url} rel="noreferrer" target="_blank" title={group.url}>
                      {group.url}
                    </a>
                  </div>
                  <span>{group.count.toLocaleString()} physical copies</span>
                </header>
                <div className="duplicate-group-meta">
                  <strong>{browserLabel(group.browser)}</strong>
                  <span>{view.closeCandidateCount.toLocaleString()} safe to close</span>
                  {view.protectedCount > 0 ? (
                    <span>{view.protectedCount.toLocaleString()} active or pinned</span>
                  ) : null}
                </div>
                <ul>
                  {group.instances.map((instance) => (
                    <li key={instance.instanceId}>
                      <span>
                        Window {instance.windowId}, position {instance.index + 1}
                        {instance.browserTabId === null
                          ? ""
                          : `, tab ${instance.browserTabId}`}
                      </span>
                      <span className="instance-flags">
                        {instance.active ? <em>Active</em> : null}
                        {instance.pinned ? <em>Pinned</em> : null}
                        <strong>{instanceDisposition(group, instance.instanceId)}</strong>
                      </span>
                    </li>
                  ))}
                </ul>
                <footer>
                  {view.reason ? <span>{view.reason}</span> : <span>Keeper is preserved.</span>}
                  <button
                    disabled={
                      !view.canClose || previewMutation.isPending || closeMutation.isPending
                    }
                    type="button"
                    onClick={(event) => {
                      confirmationTriggerRef.current = event.currentTarget;
                      previewMutation.mutate({ urls: [group.url] });
                    }}
                  >
                    Review closing {view.closeCandidateCount.toLocaleString()}
                  </button>
                </footer>
              </article>
            );
          })}
          {groupsQuery.isSuccess && groupsQuery.data.totalGroups === 0 ? (
            <p className="duplicate-state" role="status">
              No exact raw-URL duplicate groups were found.
            </p>
          ) : null}
          {groupsQuery.data && groupsQuery.data.totalGroups > groupsQuery.data.pageSize ? (
            <nav className="duplicate-pagination" aria-label="Duplicate group pages">
              <span>
                Page {page.toLocaleString()} of {totalPages.toLocaleString()}
              </span>
              <div>
                <button
                  disabled={page <= 1 || groupsQuery.isFetching}
                  type="button"
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  Previous
                </button>
                <button
                  disabled={page >= totalPages || groupsQuery.isFetching}
                  type="button"
                  onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                >
                  Next
                </button>
              </div>
            </nav>
          ) : null}
        </div>
      ) : null}

      {pendingConfirmation ? (
        <div className="confirmation-backdrop" role="presentation">
          <section
            aria-describedby="duplicate-confirm-description"
            aria-labelledby="duplicate-confirm-title"
            aria-modal="true"
            className="duplicate-confirmation"
            ref={confirmationDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <p>Final confirmation</p>
            <h3 id="duplicate-confirm-title">
              Close {pendingConfirmation.preview.totalCloseCandidates.toLocaleString()} exact
              duplicate tabs?
            </h3>
            <div id="duplicate-confirm-description">
              <p>
                The {browserLabel(connectedBrowser)} extension just re-checked{" "}
                {pendingConfirmation.preview.totalGroups.toLocaleString()} groups. It will
                preserve one keeper per URL and will not close active or pinned tabs.
              </p>
              {pendingConfirmation.preview.totalProtected > 0 ? (
                <p>
                  {pendingConfirmation.preview.totalProtected.toLocaleString()} protected
                  copies will remain open.
                </p>
              ) : null}
            </div>
            <div className="confirmation-actions">
              <button
                disabled={closeMutation.isPending}
                type="button"
                onClick={dismissConfirmation}
              >
                Cancel
              </button>
              <button
                className="danger-action"
                disabled={closeMutation.isPending}
                type="button"
                onClick={() => {
                  setCloseRequested(true);
                  closeMutation.mutate(pendingConfirmation);
                }}
              >
                {closeMutation.isPending
                  ? "Closing safely..."
                  : `Close ${pendingConfirmation.preview.totalCloseCandidates.toLocaleString()} tabs`}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <span className="sr-only">
        {pagePlan
          ? `${pagePlan.closeCount} candidates in visible groups belong to this browser installation.`
          : "No visible duplicate groups can be controlled by this browser installation."}
      </span>
    </section>
  );
}
