import type {
  PersonalPriorityLifecycleRequest,
  PersonalPriorityDraft,
} from "@tabhub/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiRequestError,
  changePersonalPriorityRules,
  fetchAllLibraryTabSelection,
  fetchLibraryOpenTabSelection,
  fetchPersonalPriorityRules,
  fetchPersonalPriorityRulesVersion,
  fetchResources,
  fetchTabs,
  previewPersonalPriorityRules,
  resetLocalSessionBootstrapForTests,
} from "../src/api";

const activeRef = { rulesetId: 1, version: 1 };
const draft: PersonalPriorityDraft = { kind: "structured", additions: [] };

afterEach(() => {
  resetLocalSessionBootstrapForTests();
  vi.unstubAllGlobals();
});

describe("priority personalization API", () => {
  it("applies opt-in ordering/review to page and Resource lists but never to bulk priority mode", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ items: [], total: 0, page: 2, pageSize: 50 }))
      .mockResolvedValueOnce(Response.json({ items: [], total: 0, page: 2, pageSize: 20 }))
      .mockResolvedValueOnce(Response.json({ ids: [7, 8], logicalPageCount: 1 }))
      .mockResolvedValueOnce(Response.json({ items: [], total: 0, logicalPageCount: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const common = {
      browser: "all",
      importance: "all" as const,
      q: "",
      status: "all" as const,
      tag: "",
      priorityMode: "recommended" as const,
      needsReview: true,
    };

    await fetchTabs({ ...common, openState: "all", page: 2 });
    await fetchResources({ ...common, page: 2, pageSize: 20 });
    await fetchAllLibraryTabSelection({ ...common, openState: "all" });
    await fetchLibraryOpenTabSelection({ ...common, openState: "all" });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/tabs?page=2&pageSize=50&priority_mode=recommended&needs_review=true",
      "/api/resources?page=2&pageSize=20&sort_by=name&sort_direction=asc&priority_mode=recommended&needs_review=true",
      "/api/tabs/bulk-ids?needs_review=true",
      "/api/tab-instances/library-bulk?needs_review=true",
    ]);
  });

  it("returns logical counts from canonical and physical Library selections", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ids: [7, 8], logicalPageCount: 1 }))
      .mockResolvedValueOnce(Response.json({ items: [], total: 2, logicalPageCount: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const filters = {
      browser: "all",
      importance: "all" as const,
      openState: "all" as const,
      q: "",
      status: "all" as const,
      tag: "",
    };

    await expect(fetchAllLibraryTabSelection(filters)).resolves.toEqual({
      ids: [7, 8], logicalPageCount: 1,
    });
    await expect(fetchLibraryOpenTabSelection(filters)).resolves.toMatchObject({
      items: [], total: 2, logicalPageCount: 1,
    });
  });

  it("uses local rules routes, exact-version reads, and the shared browser fingerprint", async () => {
    const state = {
      name: "Personal priority rules",
      baselineRef: activeRef,
      activeRef,
      latestVersion: null,
      versions: [],
      versionCount: 0,
      historyTruncated: false,
      recomputeRequired: false,
      staleOutcomeCount: 0,
    };
    const version = {
      ref: { rulesetId: 2, version: 4 }, createdBy: "user",
      createdAt: "2026-08-13T10:00:00.000Z", naturalLanguageSource: null,
      astHash: "a".repeat(64), additions: [], active: false,
    };
    const preview = {
      compiler: { kind: "structured", compilerVersion: null, sourceSpans: [], readableRules: [] },
      candidate: { additions: [], astHash: "b".repeat(64), naturalLanguageSource: null,
        totalRuleCount: 8 },
      diff: { added: [], changed: [], removed: [] }, examples: [], eligibleCount: 0, strataCounts: { exclusionChanged: 0, bandChanged: 0, assessmentChanged: 0, unchanged: 0 },
      scannedCount: 0, comparedActiveRef: activeRef, comparedActiveAstHash: "a".repeat(64),
      requestFingerprint: "c".repeat(64),
    };
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === "/api/local/session/bootstrap") return new Response(null, { status: 404 });
      if (url === "/api/personalization/rules") return Response.json(state);
      if (url.endsWith("/2/4")) return Response.json(version);
      if (url.endsWith("/preview")) return Response.json(preview);
      const request = JSON.parse(String(init?.body)) as PersonalPriorityLifecycleRequest;
      return Response.json({
        operation: request.kind, target: { rulesetId: 2, version: 4 }, activeRef,
        latestVersion: 4, requestFingerprint: request.requestFingerprint,
        replayed: false, changed: true, recomputeRequired: false, staleOutcomeCount: 0,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPersonalPriorityRules()).resolves.toEqual(state);
    await expect(fetchPersonalPriorityRulesVersion({ rulesetId: 2, version: 4 }))
      .resolves.toEqual(version);
    await expect(previewPersonalPriorityRules(draft)).resolves.toEqual(preview);
    const changed = await changePersonalPriorityRules({
      kind: "save", draft, expectedLatestVersion: null, expectedActiveRef: activeRef,
    });
    expect(changed.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const lifecycle = fetchMock.mock.calls.at(-1)!;
    expect(lifecycle[0]).toBe("/api/personalization/rules/versions");
    expect(JSON.parse(String(lifecycle[1]?.body))).toMatchObject({
      kind: "save", expectedActiveRef: activeRef, requestFingerprint: changed.requestFingerprint,
    });
  });

  it("preserves typed rule errors and exact source spans", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({
        error: "PRIORITY_RULE_LANGUAGE_UNSUPPORTED",
        message: "Unsupported condition",
        span: { start: 9, end: 17 },
      }, { status: 400 })));

    const error = await previewPersonalPriorityRules({
      kind: "natural_language",
      locale: "en",
      source: "pages when maybe then score add 10",
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      code: "PRIORITY_RULE_LANGUAGE_UNSUPPORTED",
      status: 400,
      span: { start: 9, end: 17 },
    });
  });
});
