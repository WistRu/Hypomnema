import type {
  PrivacyPurgePublicTarget,
  PrivacyPurgeStatusResponse,
} from "@tabhub/shared";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import {
  fetchPrivacyPurgeStatus,
  retryPrivacyPurge,
  startPrivacyPurge,
} from "./api";
import { useI18n } from "./i18n";
import {
  liveAcquisitionPersistenceKeys,
  persistActivePrivacyPurge,
  readActivePrivacyPurge,
} from "./live-acquisition-model";
import { activateModalDialog } from "./modal-dialog";
import "./ResearchPurgeControl.css";

export type ResearchPurgeTarget =
  | { readonly kind: "run"; readonly researchRunId: number }
  | { readonly kind: "resource_history"; readonly resourceId: number };

export interface ResearchPurgeControlProps {
  readonly target: ResearchPurgeTarget;
  readonly label: string;
  readonly privacyPurgeEnabled: boolean;
  readonly onCompleted?: (receipt: PrivacyPurgeStatusResponse) => void;
  readonly pollIntervalMs?: number;
  readonly storage?: Storage;
}

interface PendingPurgeRef {
  readonly idempotencyKey: string;
  readonly purgeId: string | null;
}

function targetIdentity(target: ResearchPurgeTarget): string {
  return target.kind === "run"
    ? `run.${target.researchRunId}`
    : `resource_history.${target.resourceId}`;
}

export function researchPurgeStorageKey(target: ResearchPurgeTarget): string {
  return `${liveAcquisitionPersistenceKeys.privacyPurge}.${targetIdentity(target)}`;
}

function scopedStorage(storage: Storage, key: string) {
  return {
    getItem: (requested: string) =>
      requested === liveAcquisitionPersistenceKeys.privacyPurge
        ? storage.getItem(key)
        : null,
    setItem: (requested: string, value: string) => {
      if (requested === liveAcquisitionPersistenceKeys.privacyPurge) {
        storage.setItem(key, value);
      }
    },
    removeItem: (requested: string) => {
      if (requested === liveAcquisitionPersistenceKeys.privacyPurge) {
        storage.removeItem(key);
      }
    },
  };
}

function readPendingRef(storage: Storage, key: string): PendingPurgeRef | null {
  const persisted = readActivePrivacyPurge(scopedStorage(storage, key));
  if (persisted) return persisted;
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(",") !== "idempotencyKey,purgeId" ||
      typeof value.idempotencyKey !== "string" ||
      value.idempotencyKey.trim() !== value.idempotencyKey ||
      value.idempotencyKey.length < 1 ||
      value.idempotencyKey.length > 200 ||
      value.purgeId !== null
    ) {
      return null;
    }
    return { idempotencyKey: value.idempotencyKey, purgeId: null };
  } catch {
    return null;
  }
}

function createIdempotencyKey(target: ResearchPurgeTarget): string {
  const random = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
        value.toString(16).padStart(2, "0")).join("");
  return `research-purge.${targetIdentity(target)}.${random}`;
}

function stateLabel(state: PrivacyPurgeStatusResponse["state"], t: (key: string,
  params?: Record<string, number | string>) => string): string {
  const labels: Record<PrivacyPurgeStatusResponse["state"], string> = {
    waiting: "Waiting for safe deletion",
    failed_hold: "Deletion is on hold",
    ready: "Ready to delete",
    committed: "Deletion committed",
    completed: "Deletion completed",
    failed: "Deletion failed",
  };
  return t(labels[state]);
}

export function ResearchPurgeControl({
  target,
  label,
  privacyPurgeEnabled,
  onCompleted,
  pollIntervalMs = 1_000,
  storage = window.localStorage,
}: ResearchPurgeControlProps) {
  const { errorMessage, formatDate, formatNumber, t } = useI18n();
  const titleId = `research-purge-title-${useId()}`;
  const storageKey = useMemo(() => researchPurgeStorageKey(target), [target]);
  const targetRef = useRef(target);
  targetRef.current = target;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const completedNotifiedRef = useRef<string | null>(null);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<PrivacyPurgeStatusResponse | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  const dismissConfirmation = useCallback(() => {
    if (!pending) setConfirmationOpen(false);
  }, [pending]);

  useEffect(() => {
    if (!confirmationOpen) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    return activateModalDialog(dialog, triggerRef.current, dismissConfirmation);
  }, [confirmationOpen, dismissConfirmation]);

  const retainReceipt = useCallback((receipt: PrivacyPurgeStatusResponse,
    idempotencyKey: string) => {
    persistActivePrivacyPurge(scopedStorage(storage, storageKey), {
      idempotencyKey,
      purgeId: receipt.purgeId,
    });
    setStatus(receipt);
    setFailure(null);
  }, [storage, storageKey]);

  const replayStart = useCallback(async (reference: PendingPurgeRef,
    signal?: AbortSignal) => {
    setPending(true);
    setFailure(null);
    try {
      const receipt = await startPrivacyPurge({
        version: 1,
        idempotencyKey: reference.idempotencyKey,
        target: targetRef.current as PrivacyPurgePublicTarget,
      }, signal);
      retainReceipt(receipt, reference.idempotencyKey);
      setConfirmationOpen(false);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) setFailure(cause);
    } finally {
      setPending(false);
    }
  }, [retainReceipt]);

  useEffect(() => {
    completedNotifiedRef.current = null;
    setStatus(null);
    setFailure(null);
    const reference = readPendingRef(storage, storageKey);
    if (!reference) return;
    const controller = new AbortController();
    if (reference.purgeId === null) {
      void replayStart(reference, controller.signal);
    } else {
      setPending(true);
      void fetchPrivacyPurgeStatus(reference.purgeId, controller.signal)
        .then((receipt) => retainReceipt(receipt, reference.idempotencyKey))
        .catch((cause: unknown) => {
          if (!(cause instanceof DOMException && cause.name === "AbortError")) setFailure(cause);
        })
        .finally(() => setPending(false));
    }
    return () => controller.abort();
  }, [replayStart, retainReceipt, storage, storageKey]);

  useEffect(() => {
    if (!status || !["waiting", "failed_hold", "ready", "committed"].includes(status.state)) return;
    const reference = readPendingRef(storage, storageKey);
    if (!reference?.purgeId) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetchPrivacyPurgeStatus(reference.purgeId!, controller.signal)
        .then((receipt) => retainReceipt(receipt, reference.idempotencyKey))
        .catch((cause: unknown) => {
          if (!(cause instanceof DOMException && cause.name === "AbortError")) setFailure(cause);
        });
    }, pollIntervalMs);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [pollIntervalMs, retainReceipt, status, storage, storageKey]);

  useEffect(() => {
    if (status?.state !== "completed" || completedNotifiedRef.current === status.purgeId) return;
    completedNotifiedRef.current = status.purgeId;
    onCompleted?.(status);
    persistActivePrivacyPurge(scopedStorage(storage, storageKey), null);
  }, [onCompleted, status, storage, storageKey]);

  const begin = async () => {
    if (pending) return;
    let reference = readPendingRef(storage, storageKey);
    if (!reference) {
      reference = { idempotencyKey: createIdempotencyKey(target), purgeId: null };
      storage.setItem(storageKey, JSON.stringify(reference));
    }
    if (reference.purgeId) {
      setPending(true);
      try {
        retainReceipt(await fetchPrivacyPurgeStatus(reference.purgeId), reference.idempotencyKey);
      } catch (cause) {
        setFailure(cause);
      } finally {
        setPending(false);
      }
      return;
    }
    await replayStart(reference);
  };

  const retry = async () => {
    if (pending || !status?.canRetry) return;
    const reference = readPendingRef(storage, storageKey);
    if (!reference?.purgeId) return;
    setPending(true);
    setFailure(null);
    try {
      retainReceipt(await retryPrivacyPurge(reference.purgeId), reference.idempotencyKey);
    } catch (cause) {
      setFailure(cause);
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="research-purge-control">
      <button
        disabled={pending || (!privacyPurgeEnabled && readPendingRef(storage, storageKey) === null)}
        onClick={() => setConfirmationOpen(true)}
        ref={triggerRef}
        type="button"
      >
        {label}
      </button>
      {!privacyPurgeEnabled && readPendingRef(storage, storageKey) === null ? (
        <p>{t("Privacy deletion is unavailable")}</p>
      ) : null}
      <div aria-live="polite" className="research-purge-status">
        {pending ? <p>{t("Updating deletion status...")}</p> : null}
        {status ? (
          <>
            <strong>{stateLabel(status.state, t)}</strong>
            <p>{t("{completed} of {total} deletion steps completed", {
              completed: formatNumber(status.progress.completedSteps),
              total: formatNumber(status.progress.totalSteps),
            })}</p>
            <p>{t("Created {date}", { date: formatDate(status.timestamps.createdAt) })}</p>
            <p>{t("Updated {date}", { date: formatDate(status.timestamps.updatedAt) })}</p>
            {status.timestamps.completedAt ? (
              <p>{t("Completed {date}", {
                date: formatDate(status.timestamps.completedAt),
              })}</p>
            ) : null}
            {status.holdReason ? (
              <p>{t(status.holdReason === "manual_review"
                ? "Deletion requires manual review"
                : "Waiting for provider settlement")}</p>
            ) : null}
            {status.state === "completed" && status.result ? (
              <p>{t("Deleted {count} stored rows", {
                count: formatNumber(status.result.deletedRows),
                rawCount: status.result.deletedRows,
              })}</p>
            ) : null}
            {status.canRetry ? (
              <button disabled={pending} onClick={() => void retry()} type="button">
                {t("Retry deletion")}
              </button>
            ) : null}
          </>
        ) : null}
      </div>
      {failure ? <p role="alert">{t("Deletion error: {message}", {
        message: errorMessage(failure),
      })}</p> : null}
      {confirmationOpen ? (
        <div className="research-purge-backdrop">
          <section
            aria-labelledby={titleId}
            aria-modal="true"
            className="research-purge-dialog"
            ref={dialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <h3 id={titleId}>{t("Permanently delete research data?")}</h3>
            <p>{t("This irreversible action deletes the selected research data and its stored history.")}</p>
            <div className="research-purge-dialog-actions">
              <button disabled={pending} onClick={dismissConfirmation} type="button">
                {t("Cancel")}
              </button>
              <button disabled={pending} onClick={() => void begin()} type="button">
                {pending ? t("Deleting...") : t("Delete permanently")}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
