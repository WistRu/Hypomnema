import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appendResourceContext,
  changeResource,
  fetchLocalResourceContext,
  fetchResourceActivity,
  fetchResourceDetail,
  fetchResourceReviewQueue,
  fetchResources,
  resetLocalSessionBootstrapForTests,
} from "../src/api";
import { localizedErrorMessage } from "../src/i18n";

const now = "2026-08-12T10:00:00.000Z";
const resource = {
  id: 7,
  resourceKey: "platform:youtube",
  name: "YouTube",
  kind: "platform" as const,
  accessClass: "public" as const,
  lifecycleState: "active" as const,
  mergedIntoResourceId: null,
  createdAt: now,
  updatedAt: now,
};
const counts = {
  logicalPageCount: 4,
  browserPageCount: 6,
  physicalOpenCopyCount: 2,
};
const allTimeActivity = {
  window: "all" as const,
  onScreenMs: 12_000,
  activeUseMs: 4_000,
  coverageStart: null,
};
const detail = {
  resource,
  version: 2,
  rulesetVersion: 3,
  preference: { userEvaluation: null, provenance: null, updatedAt: now },
  counts,
  allTimeActivity,
  topicPaths: ["Research"],
  aliases: [],
};

afterEach(() => {
  resetLocalSessionBootstrapForTests();
  vi.unstubAllGlobals();
});

describe("resource API", () => {
  it("localizes resource CAS conflicts without exposing server detail", () => {
    const error = Object.assign(new Error("unsafe server detail"), {
      code: "RESOURCE_RULESET_VERSION_CONFLICT",
    });
    expect(localizedErrorMessage("en", error)).toBe(
      "Resource rules changed. Their latest version was reloaded; review and try again.",
    );
    expect(localizedErrorMessage("ru", error)).toBe(
      "Правила ресурса изменились. Их свежая версия уже загружена; проверьте её и повторите попытку.",
    );
  });

  it("serializes resource-list intersections and preserves honest all-time detail fields", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ items: [detail], total: 1, page: 1, pageSize: 100 }))
      .mockResolvedValueOnce(Response.json(detail));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchResources({
      browser: "chrome",
      importance: 2,
      q: "video",
      status: "in_progress",
      tag: "Research",
    })).resolves.toMatchObject({ items: [{ counts }] });
    await expect(fetchResourceDetail(7)).resolves.toMatchObject({
      allTimeActivity: { window: "all", coverageStart: null },
      counts,
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/resources?page=1&pageSize=100&sort_by=name&sort_direction=asc&browser=chrome&importance=2&q=video&status=in_progress&tag=Research",
      "/api/resources/7",
    ]);
  });

  it("pages the unmatched and ambiguous review queue", async () => {
    const fetchMock = vi.fn(async () => Response.json({ items: [], total: 0, page: 3, pageSize: 50 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchResourceReviewQueue(3, 50);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/resources/review-queue?resolution=unmatched_or_ambiguous&page=3&pageSize=50",
    );
  });

  it("loads an exact resource activity window and rejects mismatched subjects or windows", async () => {
    const activity = {
      window: "7d" as const,
      onScreenMs: 7_000,
      activeUseMs: 3_000,
      coverageStart: "2026-08-01T00:00:00.000Z",
      windowStart: "2026-08-06T00:00:00.000Z",
      windowEnd: "2026-08-13T00:00:00.000Z",
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ resourceId: 7, activity }))
      .mockResolvedValueOnce(Response.json({ resourceId: 8, activity }))
      .mockResolvedValueOnce(Response.json({
        resourceId: 7,
        activity: { ...activity, window: "30d" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchResourceActivity(7, "7d")).resolves.toEqual({
      resourceId: 7,
      activity,
    });
    await expect(fetchResourceActivity(7, "7d")).rejects.toThrow(
      "TabHub returned unexpected resource activity.",
    );
    await expect(fetchResourceActivity(7, "7d")).rejects.toThrow(
      "TabHub returned unexpected resource activity.",
    );
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/resources/7/activity?window=7d",
      "/api/resources/7/activity?window=7d",
      "/api/resources/7/activity?window=7d",
    ]);
  });

  it("keeps resource context and CAS commands behind the local session without client provenance", async () => {
    const subject = { type: "resource" as const, resourceId: 7 };
    const entry = {
      id: 11,
      subject,
      entryKind: "note" as const,
      body: "Useful talks",
      provenance: { actor: "user" as const, method: "manual" as const },
      visibility: "local_only" as const,
      staleAt: null,
      supersedesId: null,
      state: "active" as const,
      operation: "append" as const,
      revision: 1,
      idempotencyKey: "local:note",
      createdAt: now,
      withdrawnAt: null,
      currentReview: null,
    };
    const aliasReceipt = {
      idempotencyKey: "local:aliases",
      commandKind: "set_aliases" as const,
      requestFingerprint: "fingerprint",
      result: {
        kind: "set_aliases" as const,
        changed: true,
        resourceId: 7,
        aliases: [{ hostPattern: "youtu.be", matchKind: "exact_host", pathPrefix: "/", priority: 100 }],
        rulesetVersion: 4,
      },
      createdAt: now,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({
        context: { subject, entries: [entry], currentEntries: [entry], preview: null },
        counts,
      }))
      .mockResolvedValueOnce(Response.json({ kind: "changed", operation: "append", entry }))
      .mockResolvedValueOnce(Response.json(aliasReceipt));
    vi.stubGlobal("fetch", fetchMock);

    await fetchLocalResourceContext(7);
    await appendResourceContext(7, {
      entryKind: "note",
      body: "Useful talks",
      visibility: "local_only",
      idempotencyKey: "note",
    });
    await changeResource({
      kind: "set_aliases",
      resourceId: 7,
      aliases: aliasReceipt.result.aliases,
      expectedResourceVersion: 2,
      expectedRulesetVersion: 3,
      idempotencyKey: "aliases",
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/local/session/bootstrap",
      "/api/local/resources/7/context",
      "/api/resources/7/context",
      "/api/resources/commands",
    ]);
    const contextBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
    const aliasBody = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body));
    expect(contextBody).toMatchObject({ kind: "append", visibility: "local_only" });
    expect(contextBody).not.toHaveProperty("subject");
    expect(contextBody).not.toHaveProperty("provenance");
    expect(aliasBody).toMatchObject({
      kind: "set_aliases",
      expectedResourceVersion: 2,
      expectedRulesetVersion: 3,
    });
    expect(aliasBody).not.toHaveProperty("provenance");
  });
});
