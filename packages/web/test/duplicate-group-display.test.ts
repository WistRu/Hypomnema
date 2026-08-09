import type { DuplicateGroup, TabInstance } from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import {
  duplicateGroupCloseSelections,
  duplicateGroupDisplayRows,
  duplicateGroupWithKeeper,
} from "../src/duplicate-group-display";

function instance(instanceId: number): TabInstance {
  return {
    instanceId,
    canonicalTabId: instanceId,
    installationId: "chrome-main",
    browserSessionId: "223e4567-e89b-42d3-a456-426614174000",
    browserTabId: instanceId + 100,
    url: "https://example.com/exact",
    urlNormalized: "https://example.com/exact",
    title: `Copy ${instanceId}`,
    browser: "chrome",
    windowId: instanceId,
    index: 0,
    faviconUrl: null,
    active: instanceId === 12,
    audible: false,
    muted: false,
    discarded: false,
    pinned: instanceId === 13,
    lastAccessed: instanceId,
    firstSeenAt: "2026-08-09T10:00:00.000Z",
    lastSeenAt: "2026-08-09T10:00:00.000Z",
    status: "inbox",
    importance: "medium",
    summary: null,
    tagPaths: [],
    duplicateGroupSize: 3,
  };
}

describe("duplicate group display", () => {
  it("lets an inactive exact copy become keeper so the active copy can close", () => {
    const group: DuplicateGroup = {
      installationId: "chrome-main",
      browser: "chrome",
      url: "https://example.com/exact",
      count: 2,
      keeperInstanceId: 12,
      candidateInstanceIds: [11],
      protectedInstanceIds: [],
      instances: [instance(12), instance(11)],
    };

    const switched = duplicateGroupWithKeeper(group, 11);

    expect(switched).not.toBeNull();
    if (switched === null) throw new Error("keeper override was rejected");
    expect(switched).toMatchObject({
      keeperInstanceId: 11,
      candidateInstanceIds: [12],
      protectedInstanceIds: [],
    });
    expect(
      duplicateGroupCloseSelections(switched).map(({ candidate, keeper }) => ({
        candidateActive: candidate.active,
        candidateId: candidate.instanceId,
        keeperActive: keeper.active,
        keeperId: keeper.instanceId,
      })),
    ).toEqual([
      {
        candidateActive: true,
        candidateId: 12,
        keeperActive: false,
        keeperId: 11,
      },
    ]);
  });

  it("rejects invalid or pinned keeper overrides and never weakens server protections", () => {
    const unprotectedGroup: DuplicateGroup = {
      installationId: "chrome-main",
      browser: "chrome",
      url: "https://example.com/exact",
      count: 2,
      keeperInstanceId: 12,
      candidateInstanceIds: [11],
      protectedInstanceIds: [],
      instances: [instance(12), instance(11)],
    };
    const pinnedCandidateGroup: DuplicateGroup = {
      ...unprotectedGroup,
      instances: unprotectedGroup.instances.map((copy) =>
        copy.instanceId === 11 ? { ...copy, pinned: true } : copy,
      ),
    };
    const pinnedKeeper = { ...instance(13), pinned: true };
    const pinnedExtra = { ...instance(15), pinned: true };
    const group: DuplicateGroup = {
      installationId: "chrome-main",
      browser: "chrome",
      url: "https://example.com/exact",
      count: 4,
      keeperInstanceId: pinnedKeeper.instanceId,
      candidateInstanceIds: [12, 14],
      protectedInstanceIds: [pinnedKeeper.instanceId, pinnedExtra.instanceId],
      instances: [instance(14), pinnedExtra, instance(12), pinnedKeeper],
    };

    expect(duplicateGroupWithKeeper(unprotectedGroup, 999)).toBeNull();
    expect(duplicateGroupWithKeeper(pinnedCandidateGroup, 11)).toBeNull();
    expect(
      duplicateGroupWithKeeper(
        {
          ...unprotectedGroup,
          candidateInstanceIds: [],
        },
        11,
      ),
    ).toBeNull();
    expect(
      duplicateGroupWithKeeper(
        {
          ...unprotectedGroup,
          instances: unprotectedGroup.instances.map((copy) =>
            copy.instanceId === 12 ? { ...copy, pinned: true } : copy,
          ),
        },
        11,
      ),
    ).toBeNull();
    expect(duplicateGroupWithKeeper(group, 12)).toBeNull();
    expect(
      duplicateGroupCloseSelections(group).map(({ candidate }) => ({
        instanceId: candidate.instanceId,
        pinned: candidate.pinned,
      })),
    ).toEqual([
      { instanceId: 12, pinned: false },
      { instanceId: 14, pinned: false },
    ]);
  });

  it("keeps every group contiguous with the keeper first and explicit relationships", () => {
    const group: DuplicateGroup = {
      installationId: "chrome-main",
      browser: "chrome",
      url: "https://example.com/exact",
      count: 3,
      keeperInstanceId: 11,
      candidateInstanceIds: [12],
      protectedInstanceIds: [13],
      instances: [instance(12), instance(13), instance(11)],
    };

    expect(
      duplicateGroupDisplayRows(group).map(({ instance: tab, role, keeper }) => ({
        instanceId: tab.instanceId,
        keeperId: keeper.instanceId,
        role,
      })),
    ).toEqual([
      { instanceId: 11, keeperId: 11, role: "keeper" },
      { instanceId: 12, keeperId: 11, role: "duplicate" },
      { instanceId: 13, keeperId: 11, role: "protected" },
    ]);
  });

  it("selects only closable extras and keeps the exact retained copy attached", () => {
    const group: DuplicateGroup = {
      installationId: "chrome-main",
      browser: "chrome",
      url: "https://example.com/exact",
      count: 3,
      keeperInstanceId: 11,
      candidateInstanceIds: [12],
      protectedInstanceIds: [13],
      instances: [instance(13), instance(12), instance(11)],
    };

    expect(
      duplicateGroupCloseSelections(group).map(({ candidate, keeper }) => ({
        active: candidate.active,
        candidateId: candidate.instanceId,
        keeperId: keeper.instanceId,
      })),
    ).toEqual([{ active: true, candidateId: 12, keeperId: 11 }]);
  });

  it("keeps active candidates but excludes every pinned copy in a multi-pinned group", () => {
    const pinnedKeeper = { ...instance(13), pinned: true };
    const pinnedExtra = { ...instance(15), pinned: true };
    const group: DuplicateGroup = {
      installationId: "chrome-main",
      browser: "chrome",
      url: "https://example.com/exact",
      count: 4,
      keeperInstanceId: pinnedKeeper.instanceId,
      candidateInstanceIds: [12, 14],
      protectedInstanceIds: [pinnedKeeper.instanceId, pinnedExtra.instanceId],
      instances: [instance(14), pinnedExtra, instance(12), pinnedKeeper],
    };

    expect(
      duplicateGroupCloseSelections(group).map(({ candidate, keeper }) => ({
        active: candidate.active,
        candidateId: candidate.instanceId,
        keeperId: keeper.instanceId,
        pinned: candidate.pinned,
      })),
    ).toEqual([
      { active: true, candidateId: 12, keeperId: 13, pinned: false },
      { active: false, candidateId: 14, keeperId: 13, pinned: false },
    ]);
  });

  it("fails closed when the destructive relationship is malformed", () => {
    const base: DuplicateGroup = {
      installationId: "chrome-main",
      browser: "chrome",
      url: "https://example.com/exact",
      count: 3,
      keeperInstanceId: 11,
      candidateInstanceIds: [12],
      protectedInstanceIds: [13],
      instances: [instance(11), instance(12), instance(13)],
    };

    expect(
      duplicateGroupCloseSelections({ ...base, keeperInstanceId: 999 }),
    ).toEqual([]);
    expect(
      duplicateGroupCloseSelections({ ...base, candidateInstanceIds: [999] }),
    ).toEqual([]);
    expect(
      duplicateGroupCloseSelections({
        ...base,
        candidateInstanceIds: [13],
      }),
    ).toEqual([]);
  });
});
