import type { DuplicateGroup, TabInstance } from "@tabhub/shared";
import { describe, expect, it } from "vitest";

import { duplicateGroupClosePlan } from "../src/duplicate-group-close";
import { duplicateGroupWithKeeper } from "../src/duplicate-group-display";
import type { ExtensionProbe, PhysicalTabScope } from "../src/extension-bridge";

const installationId = "123e4567-e89b-42d3-a456-426614174000";
const browserSessionId = "223e4567-e89b-42d3-a456-426614174000";
const url = "https://example.com/exact?video=one";

function tab(instanceId: number, options: Partial<TabInstance> = {}): TabInstance {
  return {
    instanceId,
    canonicalTabId: instanceId,
    installationId,
    browserSessionId,
    browserTabId: 100 + instanceId,
    url,
    urlNormalized: url,
    title: `Copy ${instanceId}`,
    browser: "chrome",
    windowId: 1,
    index: instanceId,
    faviconUrl: null,
    active: false,
    audible: false,
    muted: false,
    discarded: false,
    pinned: false,
    lastAccessed: instanceId,
    firstSeenAt: "2026-08-09T00:00:00.000Z",
    lastSeenAt: "2026-08-09T00:00:00.000Z",
    status: "inbox",
    importance: "medium",
    summary: null,
    tagPaths: [],
    duplicateGroupSize: 3,
    ...options,
  };
}

function group(): DuplicateGroup {
  return {
    installationId,
    browser: "chrome",
    url,
    count: 3,
    keeperInstanceId: 11,
    candidateInstanceIds: [12, 13],
    protectedInstanceIds: [],
    instances: [tab(11), tab(12, { active: true }), tab(13)],
  };
}

function probe(options: Partial<Extract<ExtensionProbe, { available: true }>> = {}): ExtensionProbe {
  return {
    available: true,
    browser: "chrome",
    browserSessionId,
    installationId,
    controlWindowId: 99,
    pendingUndos: [],
    windows: [],
    ...options,
  };
}

describe("duplicate group close plan", () => {
  it("targets only server candidates and binds every one to the exact keeper", () => {
    const plan = duplicateGroupClosePlan(group(), probe());

    expect(plan.canPreview).toBe(true);
    expect(plan.candidates.map(({ instanceId }) => instanceId)).toEqual([12, 13]);
    expect(plan.targets).toEqual([
      {
        expectedUrl: url,
        keeper: { expectedUrl: url, tabId: 111 },
        tabId: 112,
      },
      {
        expectedUrl: url,
        keeper: { expectedUrl: url, tabId: 111 },
        tabId: 113,
      },
    ]);
  });

  it("targets the active copy after the user chooses another keeper", () => {
    const initial = group();
    initial.keeperInstanceId = 12;
    initial.candidateInstanceIds = [11, 13];
    initial.instances = initial.instances.map((instance) => ({
      ...instance,
      active: instance.instanceId === 12,
    }));
    const switched = duplicateGroupWithKeeper(initial, 11);
    expect(switched).not.toBeNull();
    if (switched === null) throw new Error("keeper override was rejected");

    const plan = duplicateGroupClosePlan(switched, probe());

    expect(plan.canPreview).toBe(true);
    expect(plan.targets).toContainEqual({
      expectedUrl: url,
      keeper: { expectedUrl: url, tabId: 111 },
      tabId: 112,
    });
    expect(
      plan.candidates.find(({ instanceId }) => instanceId === 12)?.active,
    ).toBe(true);
  });

  it("fails closed instead of previewing a partial or ambiguous group", () => {
    expect(
      duplicateGroupClosePlan(group(), probe({ browserSessionId: "other-session" }))
        .canPreview,
    ).toBe(false);

    const missingKeeper = group();
    missingKeeper.instances = missingKeeper.instances.map((instance) =>
      instance.instanceId === missingKeeper.keeperInstanceId
        ? { ...instance, browserTabId: null }
        : instance,
    );
    expect(duplicateGroupClosePlan(missingKeeper, probe()).canPreview).toBe(false);

    const reusedKeeperId = group();
    reusedKeeperId.instances = reusedKeeperId.instances.map((instance) =>
      instance.instanceId === 12 ? { ...instance, browserTabId: 111 } : instance,
    );
    expect(duplicateGroupClosePlan(reusedKeeperId, probe()).canPreview).toBe(false);
  });

  it("uses the owning extension's live scope even when TabHub is open elsewhere", () => {
    const owningScope: PhysicalTabScope = {
      browser: "chrome",
      browserSessionId,
      installationId,
    };
    const unavailableProbe: ExtensionProbe = {
      available: false,
      browser: null,
      browserSessionId: null,
      controlWindowId: null,
      installationId: null,
      pendingUndos: [],
      windows: [],
    };

    const plan = duplicateGroupClosePlan(
      group(),
      unavailableProbe,
      [owningScope],
    );

    expect(plan.availability).toBe("ready");
    expect(plan.canPreview).toBe(true);
    expect(plan.scope).toEqual(owningScope);
    expect(plan.targets).toHaveLength(2);
  });

  it("distinguishes an offline owner from an invalid or stale group", () => {
    const offline = duplicateGroupClosePlan(group(), undefined, []);
    expect(offline.availability).toBe("offline");
    expect(offline.canPreview).toBe(false);
    expect(offline.scope).toEqual({
      browser: "chrome",
      browserSessionId,
      installationId,
    });

    const mixedSession = group();
    mixedSession.instances = mixedSession.instances.map((instance) =>
      instance.instanceId === 13
        ? {
            ...instance,
            browserSessionId: "323e4567-e89b-42d3-a456-426614174000",
          }
        : instance,
    );
    const invalid = duplicateGroupClosePlan(mixedSession, undefined, [
      {
        browser: "chrome",
        browserSessionId,
        installationId,
      },
    ]);
    expect(invalid.availability).toBe("invalid");
    expect(invalid.canPreview).toBe(false);
    expect(invalid.scope).toBeNull();
  });
});
