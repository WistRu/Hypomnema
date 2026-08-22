import { describe, expect, it } from "vitest";

import {
  privacyPurgeStartBodySchema,
  privacyPurgeStatusResponseSchema,
} from "./privacy-purge-contracts.js";

describe("privacy purge public contracts", () => {
  it("accepts only the three public target identities", () => {
    for (const target of [
      { kind: "logical_page", logicalPageId: 1 },
      { kind: "run", researchRunId: 2 },
      { kind: "resource_history", resourceId: 3 },
    ]) {
      expect(privacyPurgeStartBodySchema.safeParse({
        version: 1, idempotencyKey: "purge-once", target,
      }).success).toBe(true);
    }
    for (const target of [
      { kind: "run", jobId: 1 },
      { kind: "logical_page", logicalPageId: 1, url: "https://secret.test" },
      { kind: "resource_history", resourceId: 1, tableName: "contents" },
    ]) {
      expect(privacyPurgeStartBodySchema.safeParse({
        version: 1, idempotencyKey: "purge-once", target,
      }).success).toBe(false);
    }
  });

  it("rejects internal identifiers and material in status responses", () => {
    const safe = {
      version: 1 as const, purgeId: `purge_${"a".repeat(64)}`,
      target: { kind: "run" as const, researchRunId: 7 }, state: "waiting" as const,
      progress: { completedSteps: 0, totalSteps: 3 }, holdReason: null,
      canRetry: false,
      timestamps: { createdAt: "2026-08-21T12:00:00.000Z",
        updatedAt: "2026-08-21T12:00:00.000Z", completedAt: null },
      result: null,
    };
    expect(privacyPurgeStatusResponseSchema.parse(safe)).toEqual(safe);
    for (const [key, value] of Object.entries({
      url: "https://secret.test", title: "secret", actionId: 1, jobId: 2,
      provider: "x", model: "y", requestId: "z", leaseToken: "l",
      fingerprint: "f", digest: "d", tableName: "contents", internalError: "sql",
    })) {
      expect(privacyPurgeStatusResponseSchema.safeParse({ ...safe, [key]: value }).success)
        .toBe(false);
    }
  });
});
