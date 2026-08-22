import { describe, expect, it } from "vitest";

import {
  contextBundleSchema,
  contextSubjectSchema,
  resourceActivityQuerySchema,
  resourceCatalogCommandSchema,
  resourceCommandReceiptSchema,
  resourceCommandSchema,
  resourceResolutionSchema,
  resourceReviewQueueQuerySchema,
  resourceReviewQueueItemSchema,
} from "./index.js";

describe("resource contracts", () => {
  const resolved = {
    logicalPageId: 1,
    state: "resolved" as const,
    reason: "system_seed" as const,
    resource: {
      id: 2,
      resourceKey: "platform:youtube",
      name: "YouTube",
      kind: "platform" as const,
      accessClass: "public" as const,
      lifecycleState: "active" as const,
      mergedIntoResourceId: null,
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
    },
    candidateResourceIds: [2],
    sourceFingerprint: "resource-resolver-v1:test",
    researchEligible: true,
    researchExclusionReason: null,
    resolvedAt: "2026-08-12T12:00:00.000Z",
  };

  it("keeps resolved and ambiguous outcomes structurally distinct", () => {
    expect(
      resourceResolutionSchema.parse(resolved),
    ).toMatchObject({ state: "resolved", resource: { id: 2 } });
    expect(() =>
      resourceResolutionSchema.parse({
        logicalPageId: 1,
        state: "ambiguous",
        reason: "authoritative_tie",
        resource: null,
        candidateResourceIds: [2],
        sourceFingerprint: "resource-resolver-v1:test",
        researchEligible: false,
        researchExclusionReason: "authoritative_tie",
        resolvedAt: "2026-08-12T12:00:00.000Z",
      }),
    ).toThrow();
  });

  it("enforces canonical candidate semantics for every resolution branch", () => {
    for (const candidateResourceIds of [[], [3], [2, 3], [2, 2]]) {
      expect(() =>
        resourceResolutionSchema.parse({ ...resolved, candidateResourceIds }),
      ).toThrow();
    }

    const ambiguous = {
      logicalPageId: 1,
      state: "ambiguous" as const,
      reason: "authoritative_tie" as const,
      resource: null,
      candidateResourceIds: [2, 3],
      sourceFingerprint: "resource-resolver-v1:test",
      researchEligible: false,
      researchExclusionReason: "authoritative_tie" as const,
      resolvedAt: "2026-08-12T12:00:00.000Z",
    };
    expect(resourceResolutionSchema.parse(ambiguous)).toMatchObject({
      candidateResourceIds: [2, 3],
    });
    for (const candidateResourceIds of [[2, 2], [3, 2]]) {
      expect(() =>
        resourceResolutionSchema.parse({ ...ambiguous, candidateResourceIds }),
      ).toThrow();
    }

    const unresolvedCommon = {
      logicalPageId: 1,
      resource: null,
      sourceFingerprint: "resource-resolver-v1:test",
      researchEligible: false as const,
      resolvedAt: "2026-08-12T12:00:00.000Z",
    };
    expect(() =>
      resourceResolutionSchema.parse({
        ...unresolvedCommon,
        state: "unmatched",
        reason: "registrable_domain_unavailable",
        candidateResourceIds: [2],
        researchExclusionReason: "registrable_domain_unavailable",
      }),
    ).toThrow();
    expect(() =>
      resourceResolutionSchema.parse({
        ...unresolvedCommon,
        state: "excluded",
        reason: "private_ip",
        candidateResourceIds: [2],
        researchExclusionReason: "private_ip",
      }),
    ).toThrow();
  });

  it("bounds review queue pagination", () => {
    expect(resourceReviewQueueQuerySchema.parse({})).toEqual({
      resolution: "unmatched_or_ambiguous",
      page: 1,
      pageSize: 50,
    });
    expect(
      resourceReviewQueueQuerySchema.parse({
        resolution: "unmatched_or_ambiguous",
      }),
    ).toEqual({
      resolution: "unmatched_or_ambiguous",
      page: 1,
      pageSize: 50,
    });
    expect(() =>
      resourceReviewQueueQuerySchema.parse({
        resolution: "unmatched_or_ambiguous",
        pageSize: 201,
      }),
    ).toThrow();
  });

  it("carries the exact nullable assignment-head CAS token in review items", () => {
    const common = {
      logicalPageId: 1,
      urlNormalized: "https://example.com/review",
      reason: "authoritative_tie" as const,
      candidateResourceIds: [2, 3],
      sourceFingerprint: "resource-resolver-v1:review",
      resolvedAt: "2026-08-12T12:00:00.000Z",
    };
    expect(resourceReviewQueueItemSchema.parse({
      ...common,
      state: "ambiguous",
      currentAssignmentId: 7,
    }).currentAssignmentId).toBe(7);
    expect(resourceReviewQueueItemSchema.parse({
      ...common,
      state: "unmatched",
      reason: "registrable_domain_unavailable",
      candidateResourceIds: [],
      currentAssignmentId: null,
    }).currentAssignmentId).toBeNull();
    expect(() => resourceReviewQueueItemSchema.parse({
      ...common,
      state: "ambiguous",
    })).toThrow();
  });

  it("keeps typed context subjects coherent and activity all-time only", () => {
    expect(contextSubjectSchema.parse({ type: "resource", resourceId: 7 }))
      .toEqual({ type: "resource", resourceId: 7 });
    expect(() => contextSubjectSchema.parse({
      type: "resource", logicalPageId: 7,
    })).toThrow();
    const entry = {
      id: 1,
      subject: { type: "resource", resourceId: 8 },
      entryKind: "note",
      body: "context",
      provenance: { actor: "user", method: "manual" },
      visibility: "share_with_ai",
      staleAt: null,
      supersedesId: null,
      state: "active",
      operation: "append",
      revision: 1,
      idempotencyKey: "context-1",
      createdAt: "2026-08-12T12:00:00.000Z",
      withdrawnAt: null,
      currentReview: null,
    };
    expect(() => contextBundleSchema.parse({
      subject: { type: "resource", resourceId: 7 },
      entries: [entry], currentEntries: [entry], preview: null,
    })).toThrow();
    expect(resourceActivityQuerySchema.parse({})).toEqual({ window: "all" });
    expect(resourceActivityQuerySchema.parse({ window: "7d" })).toEqual({
      window: "7d",
    });
  });

  it("exposes a closed resource command union and reserves evaluation for C30c", () => {
    const common = {
      idempotencyKey: "resource-command-1",
      provenance: { actor: "user" as const, method: "manual" as const },
    };
    expect(
      resourceCatalogCommandSchema.parse({
        ...common,
        kind: "set_aliases",
        resourceId: 1,
        expectedResourceVersion: 1,
        expectedRulesetVersion: 1,
        aliases: [
          {
            hostPattern: "Docs.Example.com.",
            matchKind: "exact_host",
            pathPrefix: "/team",
            priority: 10,
          },
        ],
      }),
    ).toMatchObject({ kind: "set_aliases" });
    expect(
      resourceCommandSchema.parse({
        ...common,
        kind: "set_user_evaluation",
        resourceId: 1,
        evaluation: 3,
      }),
    ).toMatchObject({ kind: "set_user_evaluation" });
    expect(() =>
      resourceCatalogCommandSchema.parse({
        ...common,
        kind: "delete",
        resourceId: 1,
      }),
    ).toThrow();
    expect(
      resourceCatalogCommandSchema.parse({
        ...common,
        kind: "apply_override",
        logicalPageId: 1,
        resourceId: null,
        expectedAssignmentId: 3,
      }),
    ).toMatchObject({ kind: "apply_override", resourceId: null });
  });

  it("validates command-specific optimistic inputs and coherent receipts", () => {
    expect(() =>
      resourceCatalogCommandSchema.parse({
        kind: "merge",
        sourceResourceId: 2,
        targetResourceId: 2,
        expectedSourceVersion: 1,
        expectedTargetVersion: 1,
        expectedRulesetVersion: 1,
        idempotencyKey: "merge-1",
        provenance: { actor: "user", method: "manual" },
      }),
    ).toThrow();
    expect(() =>
      resourceCatalogCommandSchema.parse({
        kind: "split",
        sourceResourceId: 1,
        expectedSourceVersion: 1,
        logicalPageIds: [],
        target: { kind: "existing", resourceId: 2, expectedVersion: 1 },
        idempotencyKey: "split-1",
        provenance: { actor: "user", method: "manual" },
      }),
    ).toThrow();
    expect(() =>
      resourceCommandReceiptSchema.parse({
        idempotencyKey: "rename-1",
        commandKind: "rename",
        requestFingerprint: "sha256:test",
        result: {
          kind: "set_aliases",
          changed: false,
          resourceId: 1,
          aliases: [],
          rulesetVersion: 1,
        },
        createdAt: "2026-08-12T12:00:00.000Z",
      }),
    ).toThrow();
  });
});
