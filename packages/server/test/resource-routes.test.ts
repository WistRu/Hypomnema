import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

const resourceFlags = {
  activityDailyWriter: true,
  activityWindows: true,
  context: false,
  logicalImportance: false,
  resources: true,
  priorityShadow: false,
  research: false,
} as const;

async function fixture(resources = true) {
  const directory = await mkdtemp(join(tmpdir(), "tabhub-resource-routes-"));
  const databasePath = join(directory, "tabhub.sqlite");
  const app = createApp({
    databasePath,
    logger: false,
    featureFlags: { ...resourceFlags, resources },
    localDevProxySecret: "resource-route-secret",
    clock: () => new Date("2026-08-12T12:00:00.000Z"),
    migrationClock: () => new Date("2026-08-12T12:00:00.000Z"),
  });
  let cookie = "";
  if (resources) {
    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/local/session/bootstrap",
      headers: { "x-tabhub-dev-proxy-secret": "resource-route-secret" },
    });
    cookie = String(bootstrap.headers["set-cookie"]).split(";", 1)[0]!;
  }
  const localHeaders = { cookie, "sec-fetch-site": "same-origin" };
  return { app, directory, localHeaders };
}

async function close(value: Awaited<ReturnType<typeof fixture>>) {
  await value.app.close();
  await rm(value.directory, { recursive: true, force: true });
}

describe("resource REST boundaries", () => {
  it("serves honest global counts under filters, all-time activity, and a bare review queue", async () => {
    const f = await fixture();
    try {
      const url = "https://www.youtube.com/watch?v=resource-route";
      for (const [browser, installationId, sessionId, tabId] of [
        ["chrome", "122e4567-e89b-42d3-a456-426614174000", "222e4567-e89b-42d3-a456-426614174000", 7],
        ["edge", "322e4567-e89b-42d3-a456-426614174000", "422e4567-e89b-42d3-a456-426614174000", 8],
      ] as const) {
        expect((await f.app.inject({
          method: "POST", url: "/api/ingest/snapshot",
          payload: { browser, installationId, browserSessionId: sessionId,
            tabs: [{ tabId, url, title: `${browser} YouTube`, windowId: 1, index: 0 }] },
        })).statusCode).toBe(200);
      }
      const list = (await f.app.inject({ method: "GET", url: "/api/resources" })).json();
      const youtube = list.items.find((item: { resource: { resourceKey: string } }) =>
        item.resource.resourceKey === "platform:youtube");
      const youtubeTabs = (await f.app.inject({ method: "GET", url: "/api/tabs" })).json().items;
      const chromeTab = youtubeTabs.find((tab: { browser: string }) => tab.browser === "chrome");
      expect((await f.app.inject({ method: "POST", url: "/api/tags/assign", payload: {
        ids: [chromeTab.id], tagPath: "Research/Video", assignedBy: "user",
      } })).statusCode).toBe(200);
      expect((await f.app.inject({ method: "PATCH", url: `/api/tabs/${chromeTab.id}`,
        payload: { status: "in_progress", importance: 3 } })).statusCode).toBe(200);
      const topicRowsBefore = JSON.stringify((await f.app.inject({
        method: "GET", url: "/api/tags",
      })).json());
      expect(youtube.counts).toEqual({
        logicalPageCount: 1,
        browserPageCount: 2,
        physicalOpenCopyCount: 2,
      });
      const pages = (await f.app.inject({
        method: "GET", url: `/api/resources/${youtube.resource.id}/pages?browser=chrome`,
      })).json();
      expect(pages.items).toHaveLength(1);
      expect(pages.items[0]).toMatchObject({
        browserPageCount: 2,
        physicalOpenCopyCount: 2,
        browsers: ["chrome", "edge"],
      });
      expect(pages.items[0].allTimeActivity).toEqual({
        window: "all", onScreenMs: 0, activeUseMs: 0, coverageStart: null,
      });
      const activity = await f.app.inject({
        method: "GET", url: `/api/resources/${youtube.resource.id}/activity`,
      });
      expect(activity.statusCode).toBe(200);
      expect(activity.json().activity.window).toBe("all");
      expect(activity.json().activity.coverageStart).toBeNull();
      const sevenDays = await f.app.inject({
        method: "GET", url: `/api/resources/${youtube.resource.id}/activity?window=7d`,
      });
      expect(sevenDays.statusCode).toBe(200);
      expect(sevenDays.json().activity).toMatchObject({
        window: "7d", onScreenMs: 0, activeUseMs: 0,
        windowStart: "2026-08-06T00:00:00.000Z",
        windowEnd: "2026-08-13T00:00:00.000Z",
      });
      expect(sevenDays.json().activity.coverageStart).toEqual(expect.any(String));
      expect((await f.app.inject({
        method: "GET", url: "/api/resources/review-queue",
      })).statusCode).toBe(200);
      expect((await f.app.inject({ method: "GET", url: "/api/features" })).json())
        .toMatchObject({ agentUserImportance: true, resources: true,
          activityWindows: true, context: false });
      expect((await f.app.inject({
        method: "GET", url: `/api/tabs?resource_id=${youtube.resource.id}`,
      })).json().items).toHaveLength(2);
      expect((await f.app.inject({
        method: "GET", url: `/api/tabs/bulk-ids?resource_id=${youtube.resource.id}`,
      })).json().ids).toHaveLength(2);
      expect((await f.app.inject({
        method: "GET", url: `/api/tab-instances/library-bulk?resource_id=${youtube.resource.id}`,
      })).json().items).toHaveLength(2);
      const combined = `resource_id=${youtube.resource.id}&browser=chrome&status=in_progress` +
        "&importance=3&tag=Research&q=chrome";
      const combinedList = (await f.app.inject({
        method: "GET", url: `/api/tabs?${combined}`,
      })).json();
      const combinedIds = (await f.app.inject({
        method: "GET", url: `/api/tabs/bulk-ids?${combined}`,
      })).json();
      const combinedInstances = (await f.app.inject({
        method: "GET", url: `/api/tab-instances/library-bulk?${combined}`,
      })).json();
      expect(combinedList.items.map((tab: { id: number }) => tab.id)).toEqual([chromeTab.id]);
      expect(combinedIds.ids).toEqual([chromeTab.id]);
      expect(combinedInstances.items).toHaveLength(1);
      expect(combinedInstances.items[0].canonicalTabId).toBe(chromeTab.id);
      expect((await f.app.inject({ method: "PUT",
        url: `/api/resources/${youtube.resource.id}/user-evaluation`,
        headers: f.localHeaders,
        payload: { evaluation: 2, idempotencyKey: "topic-invariance-evaluation" },
      })).statusCode).toBe(200);
      expect((await f.app.inject({ method: "POST",
        url: `/api/resources/${youtube.resource.id}/context`,
        headers: f.localHeaders,
        payload: { kind: "append", entryKind: "note", body: "topic invariant write",
          visibility: "local_only", idempotencyKey: "topic-invariance-context" },
      })).statusCode).toBe(200);
      expect(JSON.stringify((await f.app.inject({ method: "GET", url: "/api/tags" })).json()))
        .toBe(topicRowsBefore);
    } finally {
      await close(f);
    }
  });

  it("keeps resource-only local capability isolated and enforces context privacy/lifecycle", async () => {
    const f = await fixture();
    try {
      const youtube = (await f.app.inject({ method: "GET", url: "/api/resources" })).json()
        .items.find((item: { resource: { resourceKey: string } }) =>
          item.resource.resourceKey === "platform:youtube");
      expect((await f.app.inject({
        method: "GET", url: `/api/local/resources/${youtube.resource.id}/context`,
      })).statusCode).toBe(401);
      expect((await f.app.inject({
        method: "GET", url: "/api/local/pages/1/context", headers: f.localHeaders,
      })).statusCode).toBe(404);
      const agentEmpty = (await f.app.inject({
        method: "GET", url: `/api/agent/resources/${youtube.resource.id}/context`,
      })).json();
      const privateAppend = await f.app.inject({
        method: "POST", url: `/api/resources/${youtube.resource.id}/context`,
        headers: f.localHeaders,
        payload: { kind: "append", entryKind: "purpose", body: "private narwhal",
          visibility: "local_only", idempotencyKey: "private-context" },
      });
      expect(privateAppend.statusCode).toBe(200);
      const agentBefore = (await f.app.inject({
        method: "GET", url: `/api/agent/resources/${youtube.resource.id}/context`,
      })).json();
      expect(JSON.stringify(agentBefore)).toBe(JSON.stringify(agentEmpty));
      expect(JSON.stringify(agentBefore)).not.toContain("narwhal");
      const agentAppend = await f.app.inject({
        method: "POST", url: `/api/agent/resources/${youtube.resource.id}/context`,
        payload: { kind: "append", entryKind: "next_action", body: "inspect channel",
          provenance: { method: "on_behalf_of_user" }, idempotencyKey: "agent-context" },
      });
      expect(agentAppend.statusCode).toBe(200);
      const local = (await f.app.inject({
        method: "GET", url: `/api/local/resources/${youtube.resource.id}/context`,
        headers: f.localHeaders,
      })).json();
      const agentEntry = local.context.entries.find((entry: { body: string }) =>
        entry.body === "inspect channel");
      expect((await f.app.inject({
        method: "POST",
        url: `/api/resources/${youtube.resource.id}/context/${agentEntry.id}/reviews`,
        headers: f.localHeaders,
        payload: { verdict: "accepted", idempotencyKey: "accept-agent-context" },
      })).statusCode).toBe(200);
      expect((await f.app.inject({
        method: "POST",
        url: `/api/resources/${youtube.resource.id}/context/${agentEntry.id}/withdraw`,
        headers: f.localHeaders,
        payload: { idempotencyKey: "withdraw-agent-context" },
      })).statusCode).toBe(200);
    } finally {
      await close(f);
    }
  });

  it("routes evaluation and commands through receipts and rejects new merged writes", async () => {
    const f = await fixture();
    try {
      const youtube = (await f.app.inject({ method: "GET", url: "/api/resources" })).json()
        .items.find((item: { resource: { resourceKey: string } }) =>
          item.resource.resourceKey === "platform:youtube");
      const evaluationPayload = { evaluation: 3, idempotencyKey: "evaluate-youtube" };
      const firstEvaluation = await f.app.inject({ method: "PUT",
        url: `/api/resources/${youtube.resource.id}/user-evaluation`,
        headers: f.localHeaders, payload: evaluationPayload });
      expect(firstEvaluation.statusCode).toBe(200);
      expect(firstEvaluation.json().result).toMatchObject({
        kind: "set_user_evaluation", changed: true, evaluation: 3,
        provenance: { actor: "user", method: "manual" },
      });
      const replay = await f.app.inject({ method: "PUT",
        url: `/api/resources/${youtube.resource.id}/user-evaluation`,
        headers: f.localHeaders, payload: evaluationPayload });
      expect(replay.json()).toEqual(firstEvaluation.json());
      const agentPayload = { evaluation: 2, idempotencyKey: "evaluate-youtube",
        authorizationRef: "explicit-user-request:evaluate-youtube" };
      const agentEvaluation = await f.app.inject({ method: "PUT",
        url: `/api/agent/resources/${youtube.resource.id}/user-evaluation`,
        payload: agentPayload });
      expect(agentEvaluation.statusCode).toBe(200);
      expect(agentEvaluation.json()).toMatchObject({
        subject: { type: "resource", resourceId: youtube.resource.id }, value: 2,
        provenance: { actor: "agent", method: "on_behalf_of_user" },
      });
      expect((await f.app.inject({ method: "PUT",
        url: `/api/agent/resources/${youtube.resource.id}/user-evaluation`,
        payload: agentPayload })).json()).toEqual(agentEvaluation.json());
      expect((await f.app.inject({ method: "PUT",
        url: `/api/agent/resources/${youtube.resource.id}/user-evaluation`,
        payload: { ...agentPayload, evaluation: 1 } })).statusCode).toBe(409);
      expect((await f.app.inject({ method: "PUT",
        url: `/api/agent/resources/${youtube.resource.id}/user-evaluation`,
        payload: { ...agentPayload,
          provenance: { actor: "user", method: "manual" } } })).statusCode).toBe(400);
      expect((await f.app.inject({ method: "PUT",
        url: "/api/agent/resources/999999/user-evaluation",
        payload: { evaluation: 1, idempotencyKey: "agent-missing-resource",
          authorizationRef: "explicit-user-request:missing-resource" } }))
        .statusCode).toBe(404);
      expect((await f.app.inject({ method: "GET",
        url: `/api/resources/${youtube.resource.id}` })).json().preference).toMatchObject({
          userEvaluation: 2,
          provenance: { actor: "agent", method: "on_behalf_of_user" },
        });
      const create = await f.app.inject({ method: "POST", url: "/api/resources/commands",
        headers: f.localHeaders, payload: { kind: "create", resourceKey: "platform:target",
          name: "Target", resourceKind: "platform", accessClass: "public",
          idempotencyKey: "create-target" } });
      expect(create.statusCode).toBe(200);
      const target = create.json().result.resource;
      const detail = (await f.app.inject({
        method: "GET", url: `/api/resources/${youtube.resource.id}`,
      })).json();
      const merge = await f.app.inject({ method: "POST", url: "/api/resources/commands",
        headers: f.localHeaders, payload: { kind: "merge",
          sourceResourceId: youtube.resource.id, targetResourceId: target.resource.id,
          expectedSourceVersion: detail.version, expectedTargetVersion: target.version,
          expectedRulesetVersion: detail.rulesetVersion, idempotencyKey: "merge-youtube" } });
      expect(merge.statusCode).toBe(200);
      expect((await f.app.inject({ method: "PUT",
        url: `/api/resources/${youtube.resource.id}/user-evaluation`,
        headers: f.localHeaders, payload: { evaluation: 2, idempotencyKey: "new-after-merge" } }))
        .statusCode).toBe(409);
      expect((await f.app.inject({ method: "PUT",
        url: `/api/agent/resources/${youtube.resource.id}/user-evaluation`,
        payload: { evaluation: 1, idempotencyKey: "agent-new-after-merge",
          authorizationRef: "explicit-user-request:merged-resource" } }))
        .statusCode).toBe(409);
      expect((await f.app.inject({ method: "PUT",
        url: `/api/resources/${youtube.resource.id}/user-evaluation`,
        headers: f.localHeaders, payload: evaluationPayload })).json()).toEqual(firstEvaluation.json());
      expect((await f.app.inject({ method: "POST",
        url: `/api/resources/${youtube.resource.id}/context`, headers: f.localHeaders,
        payload: { kind: "append", entryKind: "note", body: "new merged write",
          visibility: "share_with_ai", idempotencyKey: "merged-context" } })).statusCode).toBe(409);
      expect((await f.app.inject({ method: "GET",
        url: `/api/local/resources/${youtube.resource.id}/context`, headers: f.localHeaders }))
        .statusCode).toBe(200);
      expect((await f.app.inject({ method: "POST", url: "/api/resources/commands",
        headers: f.localHeaders, payload: { kind: "create", resourceKey: "invalid",
          name: "Invalid", resourceKind: "website", accessClass: "public",
          idempotencyKey: "invalid-create" } })).statusCode).toBe(400);
    } finally {
      await close(f);
    }
  });

  it("exposes the review queue CAS token and accepts only its exact current value", async () => {
    const f = await fixture();
    try {
      const ingest = async (url: string, tabId: number) => f.app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          installationId: "122e4567-e89b-42d3-a456-426614174000",
          browserSessionId: "222e4567-e89b-42d3-a456-426614174000",
          tabs: [{ tabId, url, title: url, windowId: 1, index: tabId }],
        },
      });
      expect((await ingest("https://accounts.example.net/login", 70)).statusCode).toBe(200);
      expect((await ingest("https://shared.example.com/team", 71)).statusCode).toBe(200);

      const createResource = async (resourceKey: string, name: string) => {
        const response = await f.app.inject({
          method: "POST",
          url: "/api/resources/commands",
          headers: f.localHeaders,
          payload: {
            kind: "create",
            resourceKey,
            name,
            resourceKind: "website",
            accessClass: "public",
            idempotencyKey: `create-${resourceKey}`,
          },
        });
        expect(response.statusCode).toBe(200);
        return response.json().result.resource;
      };
      const first = await createResource("custom:review-first", "Review first");
      const second = await createResource("custom:review-second", "Review second");
      const setAlias = async (
        resourceId: number,
        expectedRulesetVersion: number,
        idempotencyKey: string,
      ) => f.app.inject({
        method: "POST",
        url: "/api/resources/commands",
        headers: f.localHeaders,
        payload: {
          kind: "set_aliases",
          resourceId,
          aliases: [{
            hostPattern: "shared.example.com",
            matchKind: "exact_host",
            pathPrefix: "/",
            priority: 10,
          }],
          expectedResourceVersion: 1,
          expectedRulesetVersion,
          idempotencyKey,
        },
      });
      expect((await setAlias(first.resource.id, 1, "alias-review-first")).statusCode).toBe(200);
      expect((await setAlias(second.resource.id, 2, "alias-review-second")).statusCode).toBe(200);

      const queue = (await f.app.inject({
        method: "GET",
        url: "/api/resources/review-queue",
      })).json();
      const unmatched = queue.items.find((item: { state: string }) =>
        item.state === "unmatched");
      const ambiguous = queue.items.find((item: { state: string }) =>
        item.state === "ambiguous");
      expect(unmatched.currentAssignmentId).toBeNull();
      expect(ambiguous).toMatchObject({
        candidateResourceIds: [first.resource.id, second.resource.id].sort(
          (left, right) => left - right,
        ),
        currentAssignmentId: expect.any(Number),
      });

      const override = {
        kind: "apply_override",
        logicalPageId: ambiguous.logicalPageId,
        resourceId: first.resource.id,
        expectedAssignmentId: ambiguous.currentAssignmentId,
        idempotencyKey: "review-queue-override",
      };
      expect((await f.app.inject({
        method: "POST",
        url: "/api/resources/commands",
        headers: f.localHeaders,
        payload: override,
      })).statusCode).toBe(200);
      const stale = await f.app.inject({
        method: "POST",
        url: "/api/resources/commands",
        headers: f.localHeaders,
        payload: {
          ...override,
          resourceId: second.resource.id,
          idempotencyKey: "review-queue-stale-override",
        },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: "RESOURCE_ASSIGNMENT_CONFLICT" });
    } finally {
      await close(f);
    }
  });

  it("keeps routes absent and rejects resource filters when the feature is off", async () => {
    const f = await fixture(false);
    try {
      expect((await f.app.inject({ method: "GET", url: "/api/resources" })).statusCode).toBe(404);
      expect((await f.app.inject({ method: "PUT",
        url: "/api/agent/resources/1/user-evaluation",
        payload: { evaluation: 1, idempotencyKey: "feature-off-agent-evaluation",
          authorizationRef: "explicit-user-request:feature-off" },
      })).statusCode).toBe(404);
      expect((await f.app.inject({ method: "GET", url: "/api/tabs?resource_id=1" })).json())
        .toMatchObject({ error: "FEATURE_DISABLED", feature: "resources" });
      expect((await f.app.inject({
        method: "GET", url: "/api/tab-instances/library-bulk?resource_id=1",
      })).json()).toMatchObject({ error: "FEATURE_DISABLED", feature: "resources" });
      expect((await f.app.inject({ method: "GET", url: "/api/features" })).json())
        .toMatchObject({ agentUserImportance: false, resources: false,
          activityWindows: false });
    } finally {
      await close(f);
    }
  });
});
