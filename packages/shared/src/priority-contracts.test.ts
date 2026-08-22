import { describe, expect, it } from "vitest";

import {
  agentUserImportanceRequestSchema,
  agentUserImportanceResponseSchema,
  agentPriorityFeedbackRequestSchema,
  durableJobIdParamSchema,
  featureFlagsResponseSchema,
  localPriorityFeedbackRequestSchema,
  priorityFeedbackReceiptSchema,
  priorityReadBatchRequestSchema,
  priorityReviewQueueQuerySchema,
  resourceListQuerySchema,
  tabListQuerySchema,
  tabListItemSchema,
} from "./index.js";

describe("priority route contracts", () => {
  it("accepts typed ordered batches with duplicates and rejects raw/provenance controls", () => {
    expect(priorityReadBatchRequestSchema.parse({
      subjects: [
        { type: "page", logicalPageId: 7 },
        { type: "page", logicalPageId: 7 },
        { type: "resource", resourceId: 9 },
      ],
    }).subjects).toHaveLength(3);
    expect(priorityReadBatchRequestSchema.safeParse({
      subjects: Array.from({ length: 101 }, (_, index) => ({
        type: "page", logicalPageId: index + 1,
      })),
    }).success).toBe(false);
    expect(localPriorityFeedbackRequestSchema.safeParse({
      assessmentId: 1,
      verdict: "accept",
      idempotencyKey: "local-feedback",
      provenance: { actor: "agent" },
    }).success).toBe(false);
    expect(agentPriorityFeedbackRequestSchema.safeParse({
      assessmentId: 1,
      verdict: "accept",
      idempotencyKey: "agent-feedback",
    }).success).toBe(false);
  });

  it("uses a bounded opaque review cursor contract", () => {
    expect(priorityReviewQueueQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(priorityReviewQueueQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it("keeps feedback receipts narrow and job status IDs namespaced", () => {
    expect(priorityFeedbackReceiptSchema.safeParse({
      id: 1,
      subject: { type: "page", logicalPageId: 7 },
      assessmentId: 2,
      verdict: "accept",
      note: null,
      provenance: { actor: "user", method: "manual" },
      supersedesId: null,
      supersededAt: null,
      revision: 1,
      createdAt: "2026-08-13T12:00:00.000Z",
      authorizationRef: "must-not-leak",
    }).success).toBe(false);
    expect(durableJobIdParamSchema.parse({ id: "priority_assessment:9" }))
      .toEqual({ id: "priority_assessment:9" });
    expect(durableJobIdParamSchema.safeParse({ id: "9" }).success).toBe(false);
  });

  it("discovers effective priority capabilities while accepting older servers", () => {
    const legacy = featureFlagsResponseSchema.parse({
      context: false,
      logicalImportance: true,
      resources: true,
    });
    expect(legacy).not.toHaveProperty("priorityReaders");
    expect(legacy).not.toHaveProperty("agentUserImportance");
    expect(featureFlagsResponseSchema.parse({
      context: false,
      logicalImportance: false,
      agentUserImportance: true,
      priorityAssessmentWriter: true,
      priorityPersonalization: true,
      priorityReaders: true,
      priorityShadow: true,
    })).toMatchObject({
      priorityAssessmentWriter: true,
      priorityPersonalization: true,
      priorityReaders: true,
      priorityShadow: true,
      agentUserImportance: true,
    });
    expect(featureFlagsResponseSchema.safeParse({
      context: false,
      logicalImportance: false,
      agentUserImportance: "true",
    }).success).toBe(false);
    expect(featureFlagsResponseSchema.safeParse({
      context: false,
      logicalImportance: false,
      agentUserImportance: true,
      userImportanceAgent: true,
    }).success).toBe(false);
  });

  it("keeps priority list ordering opt-in and rejects relevance pagination conflicts", () => {
    expect(tabListQuerySchema.parse({})).not.toHaveProperty("priority_mode");
    expect(tabListQuerySchema.parse({
      priority_mode: "recommended",
      needs_review: "false",
      sort_by: "title",
      sort_direction: "desc",
    })).toMatchObject({
      priority_mode: "recommended",
      needs_review: false,
      sort_by: "title",
      sort_direction: "desc",
    });
    for (const query of [
      { priority_mode: "ai", search_mode: "semantic", q: "project" },
      { priority_mode: "my", similar_to: 7 },
      { needs_review: true, search_mode: "semantic", q: "project" },
      { needs_review: false, similar_to: 7 },
    ]) {
      const parsed = tabListQuerySchema.safeParse(query);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues).toEqual(expect.arrayContaining([
          expect.objectContaining({ message: "PRIORITY_SEARCH_MODE_CONFLICT" }),
        ]));
      }
    }
    expect(tabListQuerySchema.safeParse({
      priority_mode: "recommended",
      sort_by: "importance",
    }).success).toBe(false);
    expect(tabListQuerySchema.safeParse({ priority_mode: "future" }).success)
      .toBe(false);

    expect(resourceListQuerySchema.parse({
      priority_mode: "my",
      needs_review: "true",
    })).toMatchObject({ priority_mode: "my", needs_review: true });
    expect(resourceListQuerySchema.safeParse({ priority_mode: "future" }).success)
      .toBe(false);
  });

  it("requires canonical logical identity on every browser-row projection", () => {
    const parsed = tabListItemSchema.parse({
      id: 41,
      logicalPageId: 7,
      url: "https://example.test/page",
      urlNormalized: "https://example.test/page",
      title: "Example",
      browser: "chrome",
      windowId: 1,
      index: 0,
      faviconUrl: null,
      status: "inbox",
      importance: 0,
      isOpen: true,
      firstSeenAt: "2026-08-13T12:00:00.000Z",
      lastSeenAt: "2026-08-13T12:00:00.000Z",
      closedAt: null,
      summary: null,
      tagPaths: [],
    });
    expect(parsed.logicalPageId).toBe(7);
    expect(tabListItemSchema.safeParse({ ...parsed, logicalPageId: undefined }).success)
      .toBe(false);
  });

  it("keeps agent user-importance requests strict and receipts secret-free", () => {
    const request = {
      subject: { type: "page" as const, logicalPageId: 7 },
      value: 3 as const,
      authorizationRef: "explicit-user-request:42",
      idempotencyKey: "importance:42",
    };
    expect(agentUserImportanceRequestSchema.parse(request)).toEqual(request);
    expect(agentUserImportanceRequestSchema.parse({
      ...request,
      subject: { type: "resource", resourceId: 9 },
      value: null,
    }).value).toBeNull();

    for (const forbidden of [
      "actor", "method", "model", "ruleset", "features", "fingerprint",
      "priority", "budget", "retention", "status",
    ]) {
      expect(agentUserImportanceRequestSchema.safeParse({
        ...request,
        [forbidden]: forbidden === "actor" ? "user" : {},
      }).success, forbidden).toBe(false);
    }
    for (const invalid of [
      { ...request, subject: { type: "tab", tabId: 1 } },
      { ...request, value: 0 },
      { ...request, value: 4 },
      { ...request, authorizationRef: "" },
      { ...request, idempotencyKey: " x " },
      { ...request, idempotencyKey: "x".repeat(201) },
    ]) {
      expect(agentUserImportanceRequestSchema.safeParse(invalid).success).toBe(false);
    }

    const response = agentUserImportanceResponseSchema.parse({
      subject: request.subject,
      value: request.value,
      provenance: { actor: "agent", method: "on_behalf_of_user" },
      updatedAt: "2026-08-13T12:00:00.000Z",
    });
    expect(response).not.toHaveProperty("authorizationRef");
    expect(response).not.toHaveProperty("idempotencyKey");
    expect(agentUserImportanceResponseSchema.safeParse({
      ...response,
      authorizationRef: request.authorizationRef,
    }).success).toBe(false);
  });
});
