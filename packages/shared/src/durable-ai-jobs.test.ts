import { describe, expect, it } from "vitest";

import {
  aiTaskSpecSchema,
  durableJobIdSchema,
  durableJobViewSchema,
} from "./index.js";

describe("durable AI job contracts", () => {
  it("keeps durable IDs namespaced and task specifications closed", () => {
    expect(durableJobIdSchema.parse("summary:1")).toBe("summary:1");
    expect(durableJobIdSchema.parse("priority_assessment:9007199254740991"))
      .toBe("priority_assessment:9007199254740991");
    for (const invalid of [
      "1",
      "summary:0",
      "summary:01",
      "summary:9007199254740992",
      "research:1",
      "priority_assessment:1.5",
    ]) {
      expect(durableJobIdSchema.safeParse(invalid).success, invalid).toBe(false);
    }

    const priority = {
      version: 1,
      kind: "priority_assessment",
      subject: { type: "collection", scope: "all" },
      ruleset: { rulesetId: 1, version: 1 },
      assessmentProvenance: { method: "rule" },
      inputFingerprint: "a".repeat(64),
      idempotencyKey: "priority-all-v1",
      stepBatchSize: 100,
      provenance: { requestedBy: "user", requestMethod: "manual" },
      schedulingPriority: 10,
      budget: {
        maxSteps: 1_000,
        maxTokens: 0,
        maxCostUsd: 0,
        maxWallTimeMs: 60_000,
      },
    } as const;
    expect(aiTaskSpecSchema.parse(priority)).toEqual(priority);
    expect(aiTaskSpecSchema.parse({
      ...priority,
      idempotencyKey: "scheduled-priority-v1",
      provenance: { requestedBy: "system", requestMethod: "scheduled" },
    })).toMatchObject({
      provenance: { requestedBy: "system", requestMethod: "scheduled" },
    });
    expect(aiTaskSpecSchema.safeParse({ ...priority, stepBatchSize: 101 }).success)
      .toBe(false);
    const modelPriority = aiTaskSpecSchema.parse({
      ...priority,
      assessmentProvenance: {
        method: "model",
        model: { provider: "openai", name: "gpt-5", promptVersion: "priority-v1" },
      },
    });
    expect(modelPriority.kind).toBe("priority_assessment");
    if (modelPriority.kind !== "priority_assessment") throw new Error("wrong task kind");
    expect(modelPriority.assessmentProvenance).toEqual({
      method: "model",
      model: { provider: "openai", name: "gpt-5", promptVersion: "priority-v1" },
    });
    expect(aiTaskSpecSchema.safeParse({
      ...priority,
      assessmentProvenance: { method: "rule", model: { provider: "x" } },
    }).success).toBe(false);
    expect(aiTaskSpecSchema.safeParse({
      ...priority,
      idempotencyKey: "я".repeat(101),
    }).success).toBe(false);
    expect(aiTaskSpecSchema.safeParse({ ...priority, prompt: "PRIVATE_SENTINEL" }).success)
      .toBe(false);
  });

  it("defines typed views without reclassifying legacy summary failures", () => {
    const view = {
      id: "summary:7",
      kind: "page_summary",
      subject: { type: "tab", tabId: 3 },
      status: "failed",
      attempts: 1,
      maxAttempts: 3,
      progress: { completed: 0, total: 1, stage: "failed" },
      canCancel: false,
      cancellationRequest: null,
      createdAt: "2026-08-13T01:00:00.000Z",
      startedAt: "2026-08-13T01:00:01.000Z",
      completedAt: "2026-08-13T01:00:02.000Z",
      nextAttemptAt: null,
      error: { type: "legacy_summary", message: "opaque legacy failure" },
      result: null,
    } as const;
    expect(durableJobViewSchema.parse(view)).toEqual(view);
    expect(durableJobViewSchema.safeParse({ ...view, inferredSuperseded: true }).success)
      .toBe(false);
    for (const invalid of [
      { ...view, status: "queued", completedAt: null, nextAttemptAt: view.createdAt,
        result: { type: "page_summary", value: { summary: "x", model: "m",
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } } } },
      { ...view, status: "succeeded", result: null, error: null },
      { ...view, status: "running", completedAt: view.completedAt, error: null },
      { ...view, status: "cancelled", error: null,
        result: { type: "resource_research", reportId: 1 } },
      { ...view, completedAt: "2026-07-01T00:00:00.000Z" },
    ]) {
      expect(durableJobViewSchema.safeParse(invalid).success).toBe(false);
    }
    expect(durableJobViewSchema.safeParse({
      ...view,
      status: "queued",
      completedAt: null,
      nextAttemptAt: view.createdAt,
      error: { type: "legacy_summary", message: "retryable legacy failure" },
    }).success).toBe(true);
    expect(durableJobViewSchema.safeParse({
      ...view,
      status: "failed",
      attempts: 0,
      startedAt: null,
    }).success).toBe(true);
    expect(durableJobViewSchema.safeParse({
      ...view,
      kind: "priority_assessment",
      id: "priority_assessment:7",
      subject: { type: "page", logicalPageId: 3 },
      status: "cancelled",
      attempts: 0,
      startedAt: null,
      canCancel: false,
      result: null,
      error: null,
    }).success).toBe(true);
    expect(durableJobViewSchema.safeParse({
      ...view,
      kind: "priority_assessment",
      id: "priority_assessment:8",
      subject: { type: "page", logicalPageId: 3 },
      status: "cancelled",
      attempts: 1,
      startedAt: null,
      canCancel: false,
      result: null,
      error: null,
    }).success).toBe(false);
  });
});
