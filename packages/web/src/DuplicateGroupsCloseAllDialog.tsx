import { useEffect, useRef } from "react";

import { useI18n } from "./i18n";
import { activateModalDialog } from "./modal-dialog";

export function DuplicateGroupsCloseAllDialog({
  blockedCandidateCount,
  blockedGroupCount,
  blockingMessage,
  busy,
  candidateCount,
  confirmationBlocked,
  excludedProfiles,
  groupCount,
  profiles,
  profileCount,
  protectedCopyCount,
  protectedGroupCount,
  onConfirm,
  onDismiss,
}: {
  blockedCandidateCount: number;
  blockedGroupCount: number;
  blockingMessage?: string | undefined;
  busy: boolean;
  candidateCount: number;
  confirmationBlocked: boolean;
  excludedProfiles: Array<{
    candidateCount: number;
    groupCount: number;
    label: string;
    reason: string;
  }>;
  groupCount: number;
  profiles: Array<{ candidateCount: number; label: string }>;
  profileCount: number;
  protectedCopyCount: number;
  protectedGroupCount: number;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const { formatNumber, t } = useI18n();
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const trigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    return activateModalDialog(dialog, trigger, onDismiss);
  }, [onDismiss]);

  return (
    <div className="confirmation-backdrop">
      <section
        aria-labelledby="duplicate-groups-close-all-title"
        aria-modal="true"
        className="duplicate-confirmation"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <p>{t("Destructive browser action")}</p>
        <h3 id="duplicate-groups-close-all-title">
          {t("Close {count} extra exact copies?", {
            count: formatNumber(candidateCount),
            rawCount: candidateCount,
          })}
        </h3>
        <div>
          <p>
            {t(
              "TabHub will keep at least one copy in each of {groups} exact-URL groups and close the extras across {profiles} connected browser profiles.",
              {
                groups: formatNumber(groupCount),
                profiles: formatNumber(profileCount),
                rawGroups: groupCount,
                rawProfiles: profileCount,
              },
            )}
          </p>
          <ul className="duplicate-close-profile-list">
            {profiles.map((profile) => (
              <li key={profile.label}>
                <span>{profile.label}</span>
                <strong>
                  {t("{count} ready to close", {
                    count: formatNumber(profile.candidateCount),
                    rawCount: profile.candidateCount,
                  })}
                </strong>
              </li>
            ))}
          </ul>
          {profileCount > 1 ? (
            <p>
              {t(
                "Browser profiles finish independently; if one disconnects, the others may still complete.",
              )}
            </p>
          ) : null}
          <p>
            {t(
              "Pinned, changed, TabHub control tabs, and exact-copy keepers are protected and rechecked immediately before closing.",
            )}
          </p>
          {blockedGroupCount > 0 ? (
            <p>
              {t(
                "{copies} extra copies in {groups} unavailable groups will not be closed.",
                {
                  copies: formatNumber(blockedCandidateCount),
                  groups: formatNumber(blockedGroupCount),
                  rawCopies: blockedCandidateCount,
                  rawGroups: blockedGroupCount,
                },
              )}
            </p>
          ) : null}
          {excludedProfiles.length > 0 ? (
            <>
              <p><strong>{t("Excluded from this cleanup")}</strong></p>
              <ul className="duplicate-close-profile-list is-excluded">
                {excludedProfiles.map((profile) => (
                  <li key={`${profile.label}\n${profile.reason}`}>
                    <span>
                      {profile.label}
                      <small>{profile.reason}</small>
                    </span>
                    <strong>
                      {t("{groups} groups · {copies} copies", {
                        copies: formatNumber(profile.candidateCount),
                        groups: formatNumber(profile.groupCount),
                        rawCopies: profile.candidateCount,
                        rawGroups: profile.groupCount,
                      })}
                    </strong>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {protectedCopyCount > 0 ? (
            <p>
              {t(
                "{copies} pinned copies in {groups} groups will remain open.",
                {
                  copies: formatNumber(protectedCopyCount),
                  groups: formatNumber(protectedGroupCount),
                  rawCopies: protectedCopyCount,
                  rawGroups: protectedGroupCount,
                },
              )}
            </p>
          ) : null}
          {blockingMessage ? (
            <p className="duplicate-action-error" role="alert">
              {blockingMessage}
            </p>
          ) : null}
        </div>
        <div className="confirmation-actions">
          <button disabled={busy} type="button" onClick={onDismiss}>
            {t("Cancel")}
          </button>
          <button
            className="danger-action"
            disabled={busy || candidateCount === 0 || confirmationBlocked}
            type="button"
            onClick={onConfirm}
          >
            {busy ? t("Working…") : t("Close duplicate copies")}
          </button>
        </div>
      </section>
    </div>
  );
}
