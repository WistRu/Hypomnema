import type { DuplicateGroup, TabInstance } from "@tabhub/shared";

import { duplicateGroupClosePlan } from "./duplicate-group-close";
import type {
  ClosePreviewResult,
  ClosePreviewTarget,
  PhysicalTabScope,
  TabMutationResult,
} from "./extension-bridge";

export type DuplicateGroupsCloseAllAvailability =
  | "blocked"
  | "empty"
  | "partial"
  | "ready";

export type DuplicateGroupCloseAllBlockReason = "invalid" | "offline";

export interface DuplicateGroupCloseAllEntry {
  group: DuplicateGroup;
  keeper: TabInstance;
  targets: ClosePreviewTarget[];
}

export interface DuplicateGroupCloseAllBatch {
  groups: DuplicateGroupCloseAllEntry[];
  scope: PhysicalTabScope;
  targets: ClosePreviewTarget[];
}

export interface BlockedDuplicateGroupCloseAllEntry {
  candidateCount: number;
  group: DuplicateGroup;
  reason: DuplicateGroupCloseAllBlockReason;
  scope: PhysicalTabScope | null;
}

export interface DuplicateGroupsCloseAllCounts {
  blockedCandidates: number;
  blockedGroups: number;
  invalidGroups: number;
  offlineGroups: number;
  protectedCopies: number;
  protectedGroups: number;
  readyCandidates: number;
  readyGroups: number;
  requestedCandidates: number;
  requestedGroups: number;
  retainedCopies: number;
  unclosableGroups: number;
}

export interface DuplicateGroupsCloseAllPlan {
  availability: DuplicateGroupsCloseAllAvailability;
  batches: DuplicateGroupCloseAllBatch[];
  blocked: BlockedDuplicateGroupCloseAllEntry[];
  canPreviewReady: boolean;
  counts: DuplicateGroupsCloseAllCounts;
}

export type DuplicateGroupCloseAllPreviewCheck =
  | {
      candidateCount: number;
      expiresAt: number;
      kind: "ready";
      previewId: string;
    }
  | {
      kind: "blocked";
      reason: "expired" | "mismatch" | "skipped";
    };

type DuplicateGroupCloseAllOutcome =
  | { entry: DuplicateGroupCloseAllEntry; kind: "ready"; scope: PhysicalTabScope }
  | { entry: BlockedDuplicateGroupCloseAllEntry; kind: "blocked" }
  | { kind: "empty" };

function sameScope(left: PhysicalTabScope, right: PhysicalTabScope): boolean {
  return (
    left.browser === right.browser &&
    left.browserSessionId === right.browserSessionId &&
    left.installationId === right.installationId
  );
}

function exactTabIdSet(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return (
    expected.size === left.length &&
    new Set(right).size === right.length &&
    right.every((tabId) => expected.has(tabId))
  );
}

/**
 * Validate the browser's live preview before it is eligible for the one global
 * confirmation. A scope with any changed/protected target is excluded as a
 * whole, so confirmation never silently performs a partial plan in that scope.
 */
export function checkDuplicateGroupsCloseAllPreview(
  batch: DuplicateGroupCloseAllBatch,
  preview: ClosePreviewResult,
  now = Date.now(),
): DuplicateGroupCloseAllPreviewCheck {
  if (preview.expiresAt <= now) {
    return { kind: "blocked", reason: "expired" };
  }
  if (preview.requested !== batch.targets.length) {
    return { kind: "blocked", reason: "mismatch" };
  }
  if (preview.skipped.length > 0) {
    return { kind: "blocked", reason: "skipped" };
  }
  if (
    !exactTabIdSet(
      batch.targets.map(({ tabId }) => tabId),
      preview.candidateTabIds,
    )
  ) {
    return { kind: "blocked", reason: "mismatch" };
  }
  return {
    candidateCount: preview.candidateTabIds.length,
    expiresAt: preview.expiresAt,
    kind: "ready",
    previewId: preview.previewId,
  };
}

/** A known close receipt must account for every previewed tab exactly once. */
export function duplicateGroupsCloseAllResultMatchesPreview(
  preview: ClosePreviewResult,
  result: TabMutationResult,
): boolean {
  if (result.kind !== "close" || result.requested !== preview.candidateTabIds.length) {
    return false;
  }
  return exactTabIdSet(
    preview.candidateTabIds,
    [
      ...result.succeededTabIds,
      ...result.skipped.map(({ tabId }) => tabId),
      ...result.failed.map(({ tabId }) => tabId),
    ],
  );
}

/**
 * Plan one close-all operation without performing I/O. Every exact duplicate
 * group fails closed independently, stays intact inside its owning browser
 * scope, and keeps every candidate bound to that group's keeper. A partial
 * plan is explicit: callers may preview its ready batches, but must disclose
 * the blocked counts rather than claiming every requested group was included.
 */
export function duplicateGroupsCloseAllPlan(
  groups: readonly DuplicateGroup[],
  connectedScopes: readonly PhysicalTabScope[],
): DuplicateGroupsCloseAllPlan {
  const outcomes: DuplicateGroupCloseAllOutcome[] = groups.map((group) => {
    const plan = duplicateGroupClosePlan(group, undefined, connectedScopes);
    if (plan.availability === "empty" && group.candidateInstanceIds.length === 0) {
      return { kind: "empty" };
    }
    if (plan.availability !== "ready" || plan.scope === null) {
      return {
        entry: {
          candidateCount: group.candidateInstanceIds.length,
          group,
          reason: plan.availability === "offline" ? "offline" : "invalid",
          scope: plan.scope,
        },
        kind: "blocked",
      };
    }

    const keeper = plan.selections[0]?.keeper;
    if (keeper === undefined) {
      return {
        entry: {
          candidateCount: group.candidateInstanceIds.length,
          group,
          reason: "invalid",
          scope: plan.scope,
        },
        kind: "blocked",
      };
    }

    return {
      entry: { group, keeper, targets: plan.targets },
      kind: "ready",
      scope: plan.scope,
    };
  });

  const physicalTabOwners = new Map<string, number[]>();
  outcomes.forEach((outcome, outcomeIndex) => {
    if (outcome.kind !== "ready") return;
    const physicalTabIds = [
      outcome.entry.keeper.browserTabId,
      ...outcome.entry.targets.map(({ tabId }) => tabId),
    ];
    for (const tabId of physicalTabIds) {
      if (tabId === null) continue;
      const key = JSON.stringify([
        outcome.scope.browser,
        outcome.scope.browserSessionId,
        outcome.scope.installationId,
        tabId,
      ]);
      const owners = physicalTabOwners.get(key) ?? [];
      owners.push(outcomeIndex);
      physicalTabOwners.set(key, owners);
    }
  });
  const conflictedOutcomes = new Set<number>();
  for (const owners of physicalTabOwners.values()) {
    if (owners.length > 1) owners.forEach((owner) => conflictedOutcomes.add(owner));
  }
  conflictedOutcomes.forEach((outcomeIndex) => {
    const outcome = outcomes[outcomeIndex];
    if (outcome?.kind !== "ready") return;
    outcomes[outcomeIndex] = {
      entry: {
        candidateCount: outcome.entry.group.candidateInstanceIds.length,
        group: outcome.entry.group,
        reason: "invalid",
        scope: outcome.scope,
      },
      kind: "blocked",
    };
  });

  const batches: DuplicateGroupCloseAllBatch[] = [];
  const blocked: BlockedDuplicateGroupCloseAllEntry[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === "blocked") {
      blocked.push(outcome.entry);
      continue;
    }
    if (outcome.kind === "empty") continue;

    let batch = batches.find(({ scope }) => sameScope(scope, outcome.scope));
    if (batch === undefined) {
      batch = { groups: [], scope: outcome.scope, targets: [] };
      batches.push(batch);
    }
    batch.groups.push(outcome.entry);
    batch.targets.push(...outcome.entry.targets);
  }

  const readyGroups = batches.reduce(
    (total, batch) => total + batch.groups.length,
    0,
  );
  const readyCandidates = batches.reduce(
    (total, batch) => total + batch.targets.length,
    0,
  );
  const requestedCandidates = groups.reduce(
    (total, group) => total + group.candidateInstanceIds.length,
    0,
  );
  const blockedCandidates = blocked.reduce(
    (total, entry) => total + entry.candidateCount,
    0,
  );
  const counts: DuplicateGroupsCloseAllCounts = {
    blockedCandidates,
    blockedGroups: blocked.length,
    invalidGroups: blocked.filter(({ reason }) => reason === "invalid").length,
    offlineGroups: blocked.filter(({ reason }) => reason === "offline").length,
    protectedCopies: groups.reduce(
      (total, group) => total + group.protectedInstanceIds.length,
      0,
    ),
    protectedGroups: groups.filter(
      ({ protectedInstanceIds }) => protectedInstanceIds.length > 0,
    ).length,
    readyCandidates,
    readyGroups,
    requestedCandidates,
    requestedGroups: groups.length,
    retainedCopies: batches.reduce(
      (total, batch) =>
        total +
        batch.groups.reduce(
          (groupTotal, entry) =>
            groupTotal + entry.group.instances.length - entry.targets.length,
          0,
        ),
      0,
    ),
    unclosableGroups: outcomes.filter(({ kind }) => kind === "empty").length,
  };

  const availability: DuplicateGroupsCloseAllAvailability =
    readyCandidates > 0
      ? blocked.length > 0
        ? "partial"
        : "ready"
      : blocked.length > 0
        ? "blocked"
        : "empty";

  return {
    availability,
    batches,
    blocked,
    canPreviewReady: readyCandidates > 0,
    counts,
  };
}
