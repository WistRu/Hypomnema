import { tabUrlMaxLength } from "@tabhub/shared";

export interface DuplicateTabLike {
  active?: boolean | undefined;
  id?: number | undefined;
  index: number;
  lastAccessed?: number | undefined;
  pendingUrl?: string | undefined;
  pinned?: boolean | undefined;
  url?: string | undefined;
  windowId: number;
}

export interface DuplicateTabAdapter {
  get(tabId: number): Promise<DuplicateTabLike>;
  remove(tabId: number): Promise<void>;
}

export interface DuplicateClosePlanGroup {
  exactUrl: string;
  keeperTabId: number;
  protectedCount: number;
  targetTabIds: number[];
}

export interface DuplicateClosePlan {
  groups: DuplicateClosePlanGroup[];
}

export interface DuplicatePreview {
  plan: DuplicateClosePlan;
  totalCloseCandidates: number;
  totalGroups: number;
  totalProtected: number;
}

export interface DuplicateCloseResult {
  closed: number;
  failed: number;
  skipped: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isTabId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

/** Validate plans crossing a persistence seam before any destructive action. */
export function parseDuplicateClosePlan(
  value: unknown,
): DuplicateClosePlan | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["groups"]) ||
    !Array.isArray(value.groups)
  ) {
    return undefined;
  }

  const groups: DuplicateClosePlanGroup[] = [];
  const seenUrls = new Set<string>();
  const seenTabIds = new Set<number>();

  for (const candidate of value.groups) {
    if (
      !isRecord(candidate) ||
      !hasOnlyKeys(candidate, [
        "exactUrl",
        "keeperTabId",
        "protectedCount",
        "targetTabIds",
      ]) ||
      typeof candidate.exactUrl !== "string" ||
      candidate.exactUrl.length === 0 ||
      candidate.exactUrl.trim() !== candidate.exactUrl ||
      candidate.exactUrl.length > tabUrlMaxLength ||
      !URL.canParse(candidate.exactUrl) ||
      seenUrls.has(candidate.exactUrl) ||
      !isTabId(candidate.keeperTabId) ||
      seenTabIds.has(candidate.keeperTabId) ||
      !Number.isInteger(candidate.protectedCount) ||
      (candidate.protectedCount as number) < 0 ||
      !Array.isArray(candidate.targetTabIds)
    ) {
      return undefined;
    }

    const targetTabIds: number[] = [];
    seenUrls.add(candidate.exactUrl);
    seenTabIds.add(candidate.keeperTabId);

    for (const targetTabId of candidate.targetTabIds) {
      if (
        !isTabId(targetTabId) ||
        targetTabId === candidate.keeperTabId ||
        seenTabIds.has(targetTabId)
      ) {
        return undefined;
      }

      seenTabIds.add(targetTabId);
      targetTabIds.push(targetTabId);
    }

    groups.push({
      exactUrl: candidate.exactUrl,
      keeperTabId: candidate.keeperTabId,
      protectedCount: candidate.protectedCount as number,
      targetTabIds,
    });
  }

  return { groups };
}

interface IdentifiedTab extends DuplicateTabLike {
  id: number;
  exactUrl: string;
}

function exactTabUrl(tab: DuplicateTabLike): string | undefined {
  if (tab.pendingUrl?.trim()) {
    return undefined;
  }

  return tab.url?.trim() || undefined;
}

function identifiedTab(tab: DuplicateTabLike): IdentifiedTab | undefined {
  const exactUrl = exactTabUrl(tab);

  if (
    exactUrl === undefined ||
    !Number.isInteger(tab.id) ||
    (tab.id as number) < 0
  ) {
    return undefined;
  }

  return { ...tab, exactUrl, id: tab.id as number };
}

function isProtected(tab: DuplicateTabLike): boolean {
  return tab.active === true || tab.pinned === true;
}

function recentFirst(left: IdentifiedTab, right: IdentifiedTab): number {
  const leftAccessed = Number.isFinite(left.lastAccessed)
    ? left.lastAccessed
    : undefined;
  const rightAccessed = Number.isFinite(right.lastAccessed)
    ? right.lastAccessed
    : undefined;

  if (leftAccessed !== undefined && rightAccessed !== undefined) {
    if (leftAccessed !== rightAccessed) {
      return leftAccessed > rightAccessed ? -1 : 1;
    }
  } else if (leftAccessed !== undefined) {
    return -1;
  } else if (rightAccessed !== undefined) {
    return 1;
  }

  return (
    left.windowId - right.windowId ||
    left.index - right.index ||
    left.id - right.id
  );
}

function keeperFirst(left: IdentifiedTab, right: IdentifiedTab): number {
  return (
    Number(right.active === true) - Number(left.active === true) ||
    Number(right.pinned === true) - Number(left.pinned === true) ||
    recentFirst(left, right)
  );
}

function closurePlan(
  tabs: readonly DuplicateTabLike[],
  urls?: readonly string[],
): DuplicateClosePlan {
  const allowedUrls =
    urls === undefined ? undefined : new Set(urls.map((url) => url.trim()));
  const groups = new Map<string, IdentifiedTab[]>();

  for (const candidate of tabs) {
    const tab = identifiedTab(candidate);

    if (tab === undefined || allowedUrls?.has(tab.exactUrl) === false) {
      continue;
    }

    const siblings = groups.get(tab.exactUrl);
    if (siblings === undefined) {
      groups.set(tab.exactUrl, [tab]);
    } else {
      siblings.push(tab);
    }
  }

  const groupsToClose: DuplicateClosePlanGroup[] = [];

  for (const [exactUrl, siblings] of groups) {
    if (siblings.length < 2) {
      continue;
    }

    const protectedTabs = siblings.filter(isProtected).sort(keeperFirst);
    const unprotectedTabs = siblings.filter((tab) => !isProtected(tab)).sort(recentFirst);
    const keeper = protectedTabs[0] ?? unprotectedTabs[0];

    if (keeper === undefined) {
      continue;
    }

    groupsToClose.push({
      exactUrl,
      keeperTabId: keeper.id,
      protectedCount: protectedTabs.length,
      targetTabIds: (
        protectedTabs.length > 0 ? unprotectedTabs : unprotectedTabs.slice(1)
      ).map((tab) => tab.id),
    });
  }

  return { groups: groupsToClose };
}

function summarizePlan(plan: DuplicateClosePlan): Omit<DuplicatePreview, "plan"> {
  return {
    totalCloseCandidates: plan.groups.reduce(
      (total, group) => total + group.targetTabIds.length,
      0,
    ),
    totalGroups: plan.groups.length,
    totalProtected: plan.groups.reduce(
      (total, group) => total + group.protectedCount,
      0,
    ),
  };
}

/**
 * Preview exact-URL duplicate cleanup. URL normalization intentionally stays
 * out of this destructive seam: fragments and query strings may carry state.
 */
export function previewObviousDuplicates(
  tabs: readonly DuplicateTabLike[],
  urls?: readonly string[],
): DuplicatePreview {
  const plan = closurePlan(tabs, urls);
  return { plan, ...summarizePlan(plan) };
}

async function readCurrentTab(
  adapter: DuplicateTabAdapter,
  tabId: number,
): Promise<DuplicateTabLike | undefined> {
  try {
    return await adapter.get(tabId);
  } catch {
    return undefined;
  }
}

/**
 * Close only live, exact duplicate copies. Every target and its retained
 * keeper are re-read at the destructive boundary, so stale server/UI state
 * can never turn a now-unique, active, pinned, or navigated tab into a target.
 */
export async function closeObviousDuplicates(
  adapter: DuplicateTabAdapter,
  plan: DuplicateClosePlan,
): Promise<DuplicateCloseResult> {
  const validatedPlan = parseDuplicateClosePlan(plan);
  if (validatedPlan === undefined) {
    throw new Error("Invalid duplicate close plan.");
  }

  let closed = 0;
  let failed = 0;
  let skipped = summarizePlan(validatedPlan).totalProtected;

  for (const group of validatedPlan.groups) {
    for (const targetTabId of group.targetTabIds) {
      const keeper = await readCurrentTab(adapter, group.keeperTabId);
      const currentTarget = await readCurrentTab(adapter, targetTabId);

      if (
        keeper === undefined ||
        currentTarget === undefined ||
        exactTabUrl(keeper) !== group.exactUrl ||
        exactTabUrl(currentTarget) !== group.exactUrl ||
        currentTarget.active === true ||
        currentTarget.pinned === true
      ) {
        skipped += 1;
        continue;
      }

      try {
        await adapter.remove(targetTabId);
        closed += 1;
      } catch {
        failed += 1;
      }
    }
  }

  return { closed, failed, skipped };
}

export async function closeObviousDuplicatesAndRefresh(
  adapter: DuplicateTabAdapter,
  refreshSnapshot: () => Promise<void>,
  plan: DuplicateClosePlan,
): Promise<DuplicateCloseResult> {
  const result = await closeObviousDuplicates(adapter, plan);
  await refreshSnapshot();
  return result;
}
