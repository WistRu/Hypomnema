import type { DuplicateGroup, TabInstance } from "@tabhub/shared";

import {
  duplicateGroupCloseSelections,
  type DuplicateGroupCloseSelection,
} from "./duplicate-group-display";
import type {
  ClosePreviewTarget,
  ExtensionProbe,
  PhysicalTabScope,
} from "./extension-bridge";

export type DuplicateGroupCloseAvailability =
  | "empty"
  | "invalid"
  | "offline"
  | "ready";

export interface DuplicateGroupClosePlan {
  availability: DuplicateGroupCloseAvailability;
  candidates: TabInstance[];
  canPreview: boolean;
  selections: DuplicateGroupCloseSelection[];
  scope: PhysicalTabScope | null;
  targets: ClosePreviewTarget[];
}

function sameScope(
  left: PhysicalTabScope,
  right: PhysicalTabScope,
): boolean {
  return (
    left.browser === right.browser &&
    left.browserSessionId === right.browserSessionId &&
    left.installationId === right.installationId
  );
}

function probeScope(probe: ExtensionProbe | undefined): PhysicalTabScope | null {
  return probe?.available === true && probe.browser !== null
    ? {
        browser: probe.browser,
        browserSessionId: probe.browserSessionId,
        installationId: probe.installationId,
      }
    : null;
}

function exactSelectionScope(
  selections: readonly DuplicateGroupCloseSelection[],
): PhysicalTabScope | null {
  const first = selections[0]?.keeper;
  if (first === undefined || first.browserSessionId === null) return null;

  const scope: PhysicalTabScope = {
    browser: first.browser,
    browserSessionId: first.browserSessionId,
    installationId: first.installationId,
  };
  const everyPhysicalTabBelongsToScope = selections.every(
    ({ candidate, keeper }) =>
      candidate.browserTabId !== null &&
      candidate.browserSessionId !== null &&
      keeper.browserTabId !== null &&
      keeper.browserSessionId !== null &&
      sameScope(scope, {
        browser: candidate.browser,
        browserSessionId: candidate.browserSessionId,
        installationId: candidate.installationId,
      }) &&
      sameScope(scope, {
        browser: keeper.browser,
        browserSessionId: keeper.browserSessionId,
        installationId: keeper.installationId,
      }),
  );
  return everyPhysicalTabBelongsToScope ? scope : null;
}

/**
 * Build one fail-closed close-preview request from the API's explicit group
 * relationship. A partial, stale, cross-profile, or ambiguous plan is never
 * advertised as a closable group.
 */
export function duplicateGroupClosePlan(
  group: DuplicateGroup,
  probe: ExtensionProbe | undefined,
  connectedScopes: readonly PhysicalTabScope[] = [],
): DuplicateGroupClosePlan {
  const selections = duplicateGroupCloseSelections(group);
  const candidates = selections.map(({ candidate }) => candidate);
  const scope = exactSelectionScope(selections);
  const targets = selections.flatMap(({ candidate, keeper }) =>
    candidate.browserTabId === null || keeper.browserTabId === null
      ? []
      : [
          {
            expectedUrl: candidate.url,
            keeper: {
              expectedUrl: keeper.url,
              tabId: keeper.browserTabId,
            },
            tabId: candidate.browserTabId,
          },
        ],
  );
  const targetTabIds = targets.map(({ tabId }) => tabId);
  const keeperTabIds = targets.flatMap(({ keeper }) =>
    keeper === undefined ? [] : [keeper.tabId],
  );
  const physicalTargetsAreUnique =
    new Set(targetTabIds).size === targetTabIds.length &&
    targetTabIds.every((tabId) => !keeperTabIds.includes(tabId));
  const directScope = probeScope(probe);
  const ownerIsConnected =
    scope !== null &&
    (directScope !== null && sameScope(scope, directScope) ||
      connectedScopes.some((connected) => sameScope(scope, connected)));
  const structurallySafe =
    candidates.length > 0 &&
    candidates.length === group.candidateInstanceIds.length &&
    targets.length === candidates.length &&
    physicalTargetsAreUnique &&
    scope !== null &&
    scope.browser === group.browser &&
    scope.installationId === group.installationId;
  const availability: DuplicateGroupCloseAvailability =
    candidates.length === 0
      ? "empty"
      : !structurallySafe
        ? "invalid"
        : ownerIsConnected
          ? "ready"
          : "offline";

  return {
    availability,
    candidates,
    canPreview: availability === "ready",
    selections,
    scope,
    targets,
  };
}
