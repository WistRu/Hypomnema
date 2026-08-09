import type {
  DuplicateGroup,
  DuplicateGroupListResponse,
} from "@tabhub/shared";

export interface DuplicateReviewSummary {
  exactGroups: number;
  physicalTabs: number;
  duplicateCopies: number;
  allInstallationCandidates: number;
  protectedTabs: number;
  controllableGroups: number;
  controllableCandidates: number;
}

export interface DuplicateGroupView {
  canClose: boolean;
  closeCandidateCount: number;
  protectedCount: number;
  reason: string | null;
}

export interface DuplicateCloseConfirmation {
  installationId: string;
  browser: string;
  groupCount: number;
  candidateInstanceIds: number[];
  closeCount: number;
  protectedCount: number;
}

function browserLabel(browser: string): string {
  switch (browser) {
    case "chrome":
      return "Chrome";
    case "edge":
      return "Edge";
    case "yandex":
      return "Yandex";
    default:
      return browser.length > 0
        ? `${browser[0]!.toUpperCase()}${browser.slice(1)}`
        : "this browser";
  }
}

export function duplicateReviewSummary(
  response: DuplicateGroupListResponse,
  connectedInstallationId: string | null,
): DuplicateReviewSummary {
  const controllable =
    connectedInstallationId === null
      ? []
      : response.items.filter(
          (group) => group.installationId === connectedInstallationId,
        );

  return {
    exactGroups: response.totalGroups,
    physicalTabs: response.totalTabsInGroups,
    duplicateCopies: response.totalDuplicateCopies,
    allInstallationCandidates: response.totalCloseCandidates,
    protectedTabs: response.totalProtected,
    controllableGroups: controllable.filter(
      (group) => group.candidateInstanceIds.length > 0,
    ).length,
    controllableCandidates: controllable.reduce(
      (total, group) => total + group.candidateInstanceIds.length,
      0,
    ),
  };
}

export function duplicateGroupView(
  group: DuplicateGroup,
  connectedInstallationId: string | null,
): DuplicateGroupView {
  const closeCandidateCount = group.candidateInstanceIds.length;
  let reason: string | null = null;

  if (connectedInstallationId === null) {
    reason = "TabHub extension is not connected to this page.";
  } else if (connectedInstallationId !== group.installationId) {
    reason = `Open TabHub in ${browserLabel(group.browser)} to close these duplicates.`;
  } else if (closeCandidateCount === 0) {
    reason = "Every extra copy is pinned, so TabHub will keep it open.";
  }

  return {
    canClose: reason === null,
    closeCandidateCount,
    protectedCount: group.protectedInstanceIds.length,
    reason,
  };
}

export function buildCloseConfirmation(
  groups: DuplicateGroup[],
  connectedInstallationId: string | null,
): DuplicateCloseConfirmation | null {
  if (connectedInstallationId === null) return null;

  const controllableGroups = groups.filter(
    (group) =>
      group.installationId === connectedInstallationId &&
      group.candidateInstanceIds.length > 0,
  );
  const firstGroup = controllableGroups[0];
  if (firstGroup === undefined) return null;

  return {
    installationId: connectedInstallationId,
    browser: firstGroup.browser,
    groupCount: controllableGroups.length,
    candidateInstanceIds: controllableGroups.flatMap(
      (group) => group.candidateInstanceIds,
    ),
    closeCount: controllableGroups.reduce(
      (total, group) => total + group.candidateInstanceIds.length,
      0,
    ),
    protectedCount: controllableGroups.reduce(
      (total, group) => total + group.protectedInstanceIds.length,
      0,
    ),
  };
}
