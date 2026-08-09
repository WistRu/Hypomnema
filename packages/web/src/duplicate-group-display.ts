import type { DuplicateGroup, TabInstance } from "@tabhub/shared";

export type DuplicateGroupDisplayRole =
  | "keeper"
  | "duplicate"
  | "protected";

export interface DuplicateGroupDisplayRow {
  instance: TabInstance;
  keeper: TabInstance;
  role: DuplicateGroupDisplayRole;
}

export interface DuplicateGroupCloseSelection {
  candidate: TabInstance;
  keeper: TabInstance;
}

function physicalOrder(left: TabInstance, right: TabInstance): number {
  return (
    Number(right.active) - Number(left.active) ||
    left.windowId - right.windowId ||
    left.index - right.index ||
    left.instanceId - right.instanceId
  );
}

/**
 * Turn the API's explicit duplicate relationship into a stable visual order.
 * The designated keeper is always first, followed by close candidates and
 * finally pinned/protected copies. Exact copies are peers; "keeper" means the
 * copy TabHub chose to retain, not an original page.
 */
export function duplicateGroupDisplayRows(
  group: DuplicateGroup,
): DuplicateGroupDisplayRow[] {
  const keeper =
    group.instances.find(
      (instance) => instance.instanceId === group.keeperInstanceId,
    ) ?? group.instances[0]!;
  const candidates = new Set(group.candidateInstanceIds);

  const rows = group.instances.map((instance): DuplicateGroupDisplayRow => ({
    instance,
    keeper,
    role:
      instance.instanceId === keeper.instanceId
        ? "keeper"
        : candidates.has(instance.instanceId)
          ? "duplicate"
          : "protected",
  }));

  const roleOrder: Record<DuplicateGroupDisplayRole, number> = {
    keeper: 0,
    duplicate: 1,
    protected: 2,
  };
  return rows.sort(
    (left, right) =>
      roleOrder[left.role] - roleOrder[right.role] ||
      physicalOrder(left.instance, right.instance),
  );
}

/** Return only server-approved extra copies, each bound to the keeper that
 * must still exist with the exact URL when the extension removes it. */
export function duplicateGroupCloseSelections(
  group: DuplicateGroup,
): DuplicateGroupCloseSelection[] {
  const keeper = group.instances.find(
    (instance) => instance.instanceId === group.keeperInstanceId,
  );
  const instancesById = new Map(
    group.instances.map((instance) => [instance.instanceId, instance]),
  );
  const candidateIds = new Set(group.candidateInstanceIds);
  const protectedIds = new Set(group.protectedInstanceIds);
  const belongsToGroup = (instance: TabInstance) =>
    instance.browser === group.browser &&
    instance.installationId === group.installationId &&
    instance.url === group.url;

  if (
    keeper === undefined ||
    group.count !== group.instances.length ||
    instancesById.size !== group.instances.length ||
    candidateIds.size !== group.candidateInstanceIds.length ||
    protectedIds.size !== group.protectedInstanceIds.length ||
    candidateIds.size === 0 ||
    candidateIds.has(keeper.instanceId) ||
    !group.instances.every(belongsToGroup) ||
    group.candidateInstanceIds.some(
      (instanceId) =>
        protectedIds.has(instanceId) ||
        instancesById.get(instanceId)?.pinned !== false,
    ) ||
    group.protectedInstanceIds.some(
      (instanceId) => instancesById.get(instanceId)?.pinned !== true,
    ) ||
    new Set([
      keeper.instanceId,
      ...group.candidateInstanceIds,
      ...group.protectedInstanceIds,
    ]).size !== instancesById.size
  ) {
    return [];
  }

  return group.candidateInstanceIds.map((instanceId) => ({
    candidate: instancesById.get(instanceId)!,
    keeper,
  }));
}

/**
 * Rebind an unprotected exact-duplicate group to the copy the user explicitly
 * chose to keep. The server remains the authority for group membership and
 * pinned protection; malformed groups and groups containing protected copies
 * cannot be weakened by a client-side override.
 */
export function duplicateGroupWithKeeper(
  group: DuplicateGroup,
  keeperInstanceId: number,
): DuplicateGroup | null {
  const serverSelections = duplicateGroupCloseSelections(group);
  const keeper = group.instances.find(
    (instance) => instance.instanceId === keeperInstanceId,
  );

  if (
    serverSelections.length === 0 ||
    serverSelections.length !== group.candidateInstanceIds.length ||
    group.protectedInstanceIds.length > 0 ||
    group.instances.some((instance) => instance.pinned) ||
    keeper === undefined ||
    keeper.pinned
  ) {
    return null;
  }

  return {
    ...group,
    keeperInstanceId,
    candidateInstanceIds: group.instances
      .filter((instance) => instance.instanceId !== keeperInstanceId)
      .map((instance) => instance.instanceId),
  };
}
