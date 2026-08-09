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

export type DuplicateModelTranslator = (
  key: string,
  params?: Record<string, number | string>,
) => string;

function translate(
  t: DuplicateModelTranslator | undefined,
  key: string,
  params: Record<string, number | string> = {},
): string {
  if (t) return t(key, params);
  return key.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

function browserLabel(
  browser: string,
  t: DuplicateModelTranslator | undefined,
): string {
  switch (browser) {
    case "chrome":
      return translate(t, "Chrome");
    case "edge":
      return translate(t, "Edge");
    case "yandex":
      return translate(t, "Yandex");
    case "other":
      return translate(t, "another browser");
    default:
      return browser.length > 0
        ? `${browser[0]!.toUpperCase()}${browser.slice(1)}`
        : translate(t, "this browser");
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
  t?: DuplicateModelTranslator,
): DuplicateGroupView {
  const closeCandidateCount = group.candidateInstanceIds.length;
  let reason: string | null = null;

  if (connectedInstallationId === null) {
    reason = translate(t, "TabHub extension is not connected to this page.");
  } else if (connectedInstallationId !== group.installationId) {
    reason = translate(t, "Open TabHub in {browser} to close these duplicates.", {
      browser: browserLabel(group.browser, t),
    });
  } else if (closeCandidateCount === 0) {
    reason = translate(
      t,
      "Every extra copy is pinned, so TabHub will keep it open.",
    );
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
