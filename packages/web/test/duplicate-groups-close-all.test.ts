import type { DuplicateGroup, TabInstance } from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import {
  checkDuplicateGroupsCloseAllPreview,
  duplicateGroupsCloseAllPlan,
  duplicateGroupsCloseAllResultMatchesPreview,
} from "../src/duplicate-groups-close-all";
import type { PhysicalTabScope } from "../src/extension-bridge";

const chromeScope: PhysicalTabScope = {
  browser: "chrome",
  browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
  installationId: "123e4567-e89b-42d3-a456-426614174000",
};

function tab(
  instanceId: number,
  url: string,
  overrides: Partial<TabInstance> = {},
): TabInstance {
  return {
    active: false,
    audible: false,
    browser: chromeScope.browser,
    browserSessionId: chromeScope.browserSessionId,
    browserTabId: 100 + instanceId,
    canonicalTabId: instanceId,
    discarded: false,
    duplicateGroupSize: 3,
    faviconUrl: null,
    firstSeenAt: "2026-08-09T00:00:00.000Z",
    importance: "medium",
    index: instanceId,
    installationId: chromeScope.installationId,
    instanceId,
    lastAccessed: instanceId,
    lastSeenAt: "2026-08-09T00:00:00.000Z",
    muted: false,
    pinned: false,
    status: "inbox",
    summary: null,
    tagPaths: [],
    title: `Copy ${instanceId}`,
    url,
    urlNormalized: url,
    windowId: 1,
    ...overrides,
  };
}

function group(
  firstInstanceId: number,
  url: string,
  scope: PhysicalTabScope = chromeScope,
): DuplicateGroup {
  const instances = [
    tab(firstInstanceId, url, {
      browser: scope.browser,
      browserSessionId: scope.browserSessionId,
      installationId: scope.installationId,
    }),
    tab(firstInstanceId + 1, url, {
      active: true,
      browser: scope.browser,
      browserSessionId: scope.browserSessionId,
      installationId: scope.installationId,
    }),
    tab(firstInstanceId + 2, url, {
      browser: scope.browser,
      browserSessionId: scope.browserSessionId,
      installationId: scope.installationId,
    }),
  ];
  return {
    browser: scope.browser,
    candidateInstanceIds: [firstInstanceId + 1, firstInstanceId + 2],
    count: instances.length,
    installationId: scope.installationId,
    instances,
    keeperInstanceId: firstInstanceId,
    protectedInstanceIds: [],
    url,
  };
}

describe("close-all duplicate plan", () => {
  it("keeps every exact group's keeper while combining one scope for one confirmation", () => {
    const first = group(10, "https://example.com/video/one");
    const second = group(20, "https://example.com/video/two");

    const plan = duplicateGroupsCloseAllPlan(
      [first, second],
      [chromeScope],
    );

    expect(plan.canPreviewReady).toBe(true);
    expect(plan.availability).toBe("ready");
    expect(plan.counts).toEqual({
      blockedCandidates: 0,
      blockedGroups: 0,
      invalidGroups: 0,
      offlineGroups: 0,
      protectedCopies: 0,
      protectedGroups: 0,
      readyCandidates: 4,
      readyGroups: 2,
      requestedCandidates: 4,
      requestedGroups: 2,
      retainedCopies: 2,
      unclosableGroups: 0,
    });
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0]).toMatchObject({
      scope: chromeScope,
      groups: [
        { group: first, keeper: first.instances[0] },
        { group: second, keeper: second.instances[0] },
      ],
    });
    expect(plan.batches[0]?.targets).toEqual([
      {
        expectedUrl: first.url,
        keeper: { expectedUrl: first.url, tabId: 110 },
        tabId: 111,
      },
      {
        expectedUrl: first.url,
        keeper: { expectedUrl: first.url, tabId: 110 },
        tabId: 112,
      },
      {
        expectedUrl: second.url,
        keeper: { expectedUrl: second.url, tabId: 120 },
        tabId: 121,
      },
      {
        expectedUrl: second.url,
        keeper: { expectedUrl: second.url, tabId: 120 },
        tabId: 122,
      },
    ]);
  });

  it("never mixes exact browser sessions or installations in one batch", () => {
    const yandexScope: PhysicalTabScope = {
      browser: "yandex",
      browserSessionId: "423e4567-e89b-42d3-a456-426614174000",
      installationId: "323e4567-e89b-42d3-a456-426614174000",
    };
    const chromeGroup = group(10, "https://example.com/chrome");
    const yandexGroup = group(
      20,
      "https://example.com/yandex",
      yandexScope,
    );

    const plan = duplicateGroupsCloseAllPlan(
      [chromeGroup, yandexGroup],
      [chromeScope, yandexScope],
    );

    expect(plan.canPreviewReady).toBe(true);
    expect(plan.batches).toHaveLength(2);
    expect(
      plan.batches.map(({ groups, scope, targets }) => ({
        groupUrls: groups.map(({ group: plannedGroup }) => plannedGroup.url),
        scope,
        targetIds: targets.map(({ tabId }) => tabId),
      })),
    ).toEqual([
      {
        groupUrls: [chromeGroup.url],
        scope: chromeScope,
        targetIds: [111, 112],
      },
      {
        groupUrls: [yandexGroup.url],
        scope: yandexScope,
        targetIds: [121, 122],
      },
    ]);
  });

  it("keeps online scopes ready while reporting every offline group", () => {
    const yandexScope: PhysicalTabScope = {
      browser: "yandex",
      browserSessionId: "423e4567-e89b-42d3-a456-426614174000",
      installationId: "323e4567-e89b-42d3-a456-426614174000",
    };
    const onlineGroup = group(10, "https://example.com/online");
    const offlineGroup = group(
      20,
      "https://example.com/offline",
      yandexScope,
    );

    const plan = duplicateGroupsCloseAllPlan(
      [onlineGroup, offlineGroup],
      [chromeScope],
    );

    expect(plan.availability).toBe("partial");
    expect(plan.canPreviewReady).toBe(true);
    expect(plan.batches).toHaveLength(1);
    expect(plan.blocked).toEqual([
      {
        candidateCount: 2,
        group: offlineGroup,
        reason: "offline",
        scope: yandexScope,
      },
    ]);
    expect(plan.counts).toMatchObject({
      blockedCandidates: 2,
      blockedGroups: 1,
      offlineGroups: 1,
      readyCandidates: 2,
      readyGroups: 1,
      requestedCandidates: 4,
      requestedGroups: 2,
    });
  });

  it("marks an incomplete candidate set invalid instead of treating it as empty", () => {
    const malformed = group(10, "https://example.com/stale");
    malformed.instances = malformed.instances.map((instance) =>
      instance.instanceId === 11
        ? { ...instance, browserTabId: null }
        : instance,
    );

    const plan = duplicateGroupsCloseAllPlan([malformed], [chromeScope]);

    expect(plan.availability).toBe("blocked");
    expect(plan.canPreviewReady).toBe(false);
    expect(plan.batches).toEqual([]);
    expect(plan.blocked).toEqual([
      {
        candidateCount: 2,
        group: malformed,
        reason: "invalid",
        scope: null,
      },
    ]);
    expect(plan.counts).toMatchObject({
      blockedCandidates: 2,
      blockedGroups: 1,
      invalidGroups: 1,
      readyCandidates: 0,
      unclosableGroups: 0,
    });
  });

  it("rejects every implicated group when snapshots reuse one physical tab", () => {
    const first = group(10, "https://example.com/first");
    const second = group(20, "https://example.com/second");
    second.instances = second.instances.map((instance) =>
      instance.instanceId === 21
        ? { ...instance, browserTabId: 111 }
        : instance,
    );

    const plan = duplicateGroupsCloseAllPlan(
      [first, second],
      [chromeScope],
    );

    expect(plan.availability).toBe("blocked");
    expect(plan.canPreviewReady).toBe(false);
    expect(plan.batches).toEqual([]);
    expect(
      plan.blocked.map(({ group: blockedGroup, reason }) => ({
        reason,
        url: blockedGroup.url,
      })),
    ).toEqual([
      { reason: "invalid", url: first.url },
      { reason: "invalid", url: second.url },
    ]);
    expect(plan.counts).toMatchObject({
      blockedCandidates: 4,
      blockedGroups: 2,
      invalidGroups: 2,
      readyCandidates: 0,
      readyGroups: 0,
    });
  });

  it("does not truncate a scope with more than 500 duplicate targets", () => {
    const groups = Array.from({ length: 260 }, (_, index) =>
      group(index * 10 + 10, `https://example.com/${index}`),
    );

    const plan = duplicateGroupsCloseAllPlan(groups, [chromeScope]);

    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0]?.targets).toHaveLength(520);
    expect(plan.counts.readyCandidates).toBe(520);
  });

  it("reports pinned copies even when a protected group has nothing to close", () => {
    const protectedGroup = group(10, "https://example.com/pinned");
    protectedGroup.instances = protectedGroup.instances.map((instance) => ({
      ...instance,
      pinned: true,
    }));
    protectedGroup.keeperInstanceId = 10;
    protectedGroup.candidateInstanceIds = [];
    protectedGroup.protectedInstanceIds = [10, 11, 12];

    const plan = duplicateGroupsCloseAllPlan([protectedGroup], [chromeScope]);

    expect(plan.availability).toBe("empty");
    expect(plan.counts).toMatchObject({
      protectedCopies: 3,
      protectedGroups: 1,
      unclosableGroups: 1,
    });
  });
});

describe("close-all duplicate live receipts", () => {
  const plannedBatch = duplicateGroupsCloseAllPlan(
    [group(10, "https://example.com/live")],
    [chromeScope],
  ).batches[0]!;
  const preview = {
    candidateTabIds: [111, 112],
    expiresAt: 10_000,
    kind: "close-preview" as const,
    previewId: "123e4567-e89b-42d3-a456-426614174000",
    requested: 2,
    skipped: [],
  };

  it("accepts only an exact, unexpired candidate set", () => {
    expect(checkDuplicateGroupsCloseAllPreview(plannedBatch, preview, 9_000)).toEqual({
      candidateCount: 2,
      expiresAt: 10_000,
      kind: "ready",
      previewId: preview.previewId,
    });
    expect(
      checkDuplicateGroupsCloseAllPreview(
        plannedBatch,
        { ...preview, candidateTabIds: [111] },
        9_000,
      ),
    ).toEqual({ kind: "blocked", reason: "mismatch" });
    expect(
      checkDuplicateGroupsCloseAllPreview(
        plannedBatch,
        { ...preview, skipped: [{ reason: "pinned", tabId: 112 }] },
        9_000,
      ),
    ).toEqual({ kind: "blocked", reason: "skipped" });
    expect(checkDuplicateGroupsCloseAllPreview(plannedBatch, preview, 10_000)).toEqual({
      kind: "blocked",
      reason: "expired",
    });
  });

  it("requires a known close result to partition every previewed tab", () => {
    expect(
      duplicateGroupsCloseAllResultMatchesPreview(preview, {
        failed: [{ error: "gone", tabId: 112 }],
        kind: "close",
        requested: 2,
        skipped: [],
        succeededTabIds: [111],
      }),
    ).toBe(true);
    expect(
      duplicateGroupsCloseAllResultMatchesPreview(preview, {
        failed: [],
        kind: "close",
        requested: 2,
        skipped: [],
        succeededTabIds: [111],
      }),
    ).toBe(false);
    expect(
      duplicateGroupsCloseAllResultMatchesPreview(preview, {
        failed: [{ error: "duplicate", tabId: 111 }],
        kind: "close",
        requested: 2,
        skipped: [],
        succeededTabIds: [111],
      }),
    ).toBe(false);
  });
});
