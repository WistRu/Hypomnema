import {
  agentUserImportanceResponseSchema,
  durableJobRefSchema,
  durableJobViewSchema,
  priorityFeedbackReceiptSchema,
  prioritySafeReadSchema,
  type PriorityFeedbackReceipt,
  type PrioritySafeRead,
} from "@tabhub/shared";
import { describe, expect, it, vi } from "vitest";

import { createTabHubApi } from "../src/tabhub-api.js";

const timestamp = "2026-08-13T07:00:00.000Z";
const privateCanary = "LOCAL_ONLY_PRIORITY_CONTEXT_MUST_NEVER_ESCAPE";

const priorityJobRef = durableJobRefSchema.parse({
  id: "priority_assessment:41",
  kind: "priority_assessment",
  status: "queued",
});

const priorityJobView = durableJobViewSchema.parse({
  ...priorityJobRef,
  subject: { type: "page", logicalPageId: 42 },
  attempts: 0,
  maxAttempts: 3,
  progress: { completed: 0, total: null, stage: "queued" },
  canCancel: true,
  cancellationRequest: null,
  createdAt: timestamp,
  startedAt: null,
  completedAt: null,
  nextAttemptAt: timestamp,
  error: null,
  result: null,
});

const pagePriority = prioritySafeReadSchema.parse({
  subject: { type: "page", logicalPageId: 42 },
  outcome: {
    kind: "assessment",
    assessment: {
      id: 71,
      subject: { type: "page", logicalPageId: 42 },
      agentScore: 78,
      agentBand: "high",
      confidence: 0.82,
      needsReview: false,
      reasons: [
        {
          code: "active-project",
          kind: "contribution",
          label: "Linked to an active project",
          scoreDelta: 15,
          confidenceDelta: 0.1,
          appliedRuleKey: "active-project",
        },
      ],
      missingSignals: ["captured_content"],
      ruleset: { rulesetId: 1, version: 1 },
      featureFingerprint: "a".repeat(64),
      assessmentMethod: "rule",
      modelProvenance: null,
      revision: 1,
      evaluatedAt: timestamp,
      supersededAt: null,
    },
  },
  isCurrent: true,
  dirty: false,
  needsReview: false,
});

const resourcePriority = prioritySafeReadSchema.parse({
  subject: { type: "resource", resourceId: 9 },
  outcome: {
    kind: "exclusion",
    exclusion: {
      id: 81,
      subject: { type: "resource", resourceId: 9 },
      reason: "private_or_internal",
      detail: { source: "url_policy", code: "private_resource" },
      ruleset: { rulesetId: 1, version: 1 },
      featureFingerprint: "b".repeat(64),
      revision: 1,
      evaluatedAt: timestamp,
      supersededAt: null,
    },
  },
  isCurrent: true,
  dirty: false,
  needsReview: false,
});

const pageFeedback = priorityFeedbackReceiptSchema.parse({
  id: 91,
  subject: { type: "page", logicalPageId: 42 },
  assessmentId: 71,
  verdict: "too_high",
  note: "The page is no longer part of the current project.",
  provenance: { actor: "agent", method: "on_behalf_of_user" },
  supersedesId: null,
  supersededAt: null,
  revision: 1,
  createdAt: timestamp,
});

const resourceFeedback = priorityFeedbackReceiptSchema.parse({
  id: 92,
  subject: { type: "resource", resourceId: 9 },
  assessmentId: 72,
  verdict: "accept",
  note: null,
  provenance: { actor: "agent", method: "on_behalf_of_user" },
  supersedesId: null,
  supersededAt: null,
  revision: 1,
  createdAt: timestamp,
});

const pageImportance = agentUserImportanceResponseSchema.parse({
  subject: { type: "page", logicalPageId: 42 },
  value: 3,
  provenance: { actor: "agent", method: "on_behalf_of_user" },
  updatedAt: timestamp,
});

const resourceImportance = agentUserImportanceResponseSchema.parse({
  subject: { type: "resource", resourceId: 9 },
  value: null,
  provenance: { actor: "agent", method: "on_behalf_of_user" },
  updatedAt: timestamp,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("TabHub priority REST adapter", () => {
  it("uses the exact agent recompute and durable-status REST contracts", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse(priorityJobRef))
      .mockResolvedValueOnce(jsonResponse(priorityJobView));
    const api = createTabHubApi({ fetchImpl });

    await expect(api.recomputePriority({
      subject: { type: "page", logicalPageId: 42 },
      idempotencyKey: "priority-recompute-page-42",
      authorizationRef: "user-instruction:priority-recompute-page-42",
      stepBatchSize: 25,
    })).resolves.toEqual(priorityJobRef);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    }))).toEqual([{
      url: "http://127.0.0.1:7717/api/agent/personalization/priority/recompute",
      method: "POST",
      body: {
        subject: { type: "page", logicalPageId: 42 },
        idempotencyKey: "priority-recompute-page-42",
        authorizationRef: "user-instruction:priority-recompute-page-42",
        stepBatchSize: 25,
      },
    }]);

    await expect(api.getJobStatus(priorityJobRef.id)).resolves.toEqual(priorityJobView);
    expect(fetchImpl.mock.calls.at(-1)).toEqual([
      "http://127.0.0.1:7717/api/ai/jobs/priority_assessment:41",
      { method: "GET" },
    ]);
  });

  it("rejects recompute provenance spoofing before sending", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const api = createTabHubApi({ fetchImpl });
    const spoofed = {
      subject: { type: "page" as const, logicalPageId: 42 },
      idempotencyKey: "priority-recompute-spoof",
      authorizationRef: "user-instruction:priority-recompute-spoof",
      stepBatchSize: 50,
      provenance: { requestedBy: "user", requestMethod: "manual" },
      ruleset: { rulesetId: 1, version: 1 },
      rawFeatures: { localContextBody: privateCanary },
    };

    await expect(api.recomputePriority(spoofed)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a non-priority job reference from the recompute route", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({
      id: "resource_research:7",
      kind: "resource_research",
      status: "queued",
    }));
    const api = createTabHubApi({ fetchImpl });

    await expect(api.recomputePriority({
      idempotencyKey: "priority-recompute-kind-mismatch",
      authorizationRef: "user-instruction:priority-recompute-kind-mismatch",
      stepBatchSize: 50,
    })).rejects.toThrow(
      "TabHub API POST /api/agent/personalization/priority/recompute returned a mismatched response",
    );
  });

  it("rejects a durable status response for a different job ID", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({
      id: "priority_assessment:8",
      kind: "priority_assessment",
      subject: { type: "collection", scope: "all" },
      status: "queued",
      attempts: 0,
      maxAttempts: 3,
      progress: { completed: 0, total: null, stage: "queued" },
      canCancel: true,
      cancellationRequest: null,
      createdAt: timestamp,
      startedAt: null,
      completedAt: null,
      nextAttemptAt: timestamp,
      error: null,
      result: null,
    }));
    const api = createTabHubApi({ fetchImpl });

    await expect(api.getJobStatus("priority_assessment:7")).rejects.toThrow(
      "TabHub API GET /api/ai/jobs/priority_assessment:7 returned a mismatched response",
    );
  });

  it("rejects non-priority job IDs before the status HTTP boundary", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const api = createTabHubApi({ fetchImpl });

    await expect(api.getJobStatus("resource_research:7")).rejects.toThrow();
    await expect(api.getJobStatus("summary:7")).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads strict safe priority projections for page and resource subjects", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse(pagePriority))
      .mockResolvedValueOnce(jsonResponse(resourcePriority));
    const api = createTabHubApi({ fetchImpl });

    await expect(
      api.explainPriority({ type: "page", logicalPageId: 42 }),
    ).resolves.toEqual(pagePriority);
    await expect(
      api.explainPriority({ type: "resource", resourceId: 9 }),
    ).resolves.toEqual(resourcePriority);

    expect(fetchImpl.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method,
      body: init?.body,
    }))).toEqual([
      {
        url: "http://127.0.0.1:7717/api/logical-pages/42/priority",
        method: "GET",
        body: undefined,
      },
      {
        url: "http://127.0.0.1:7717/api/resources/9/priority",
        method: "GET",
        body: undefined,
      },
    ]);
  });

  it("fails closed on private, malformed, or mismatched explain projections", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({ ...pagePriority, hiddenCount: 1 }))
      .mockResolvedValueOnce(jsonResponse({
        ...pagePriority,
        rawFeatures: { localContextBody: privateCanary },
      }))
      .mockResolvedValueOnce(jsonResponse({
        ...resourcePriority,
        outcome: {
          ...resourcePriority.outcome,
          exclusion: {
            ...(resourcePriority.outcome?.kind === "exclusion"
              ? resourcePriority.outcome.exclusion
              : {}),
            detail: { localContextBody: privateCanary },
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        ...pagePriority,
        subject: { type: "page", logicalPageId: 43 },
      }));
    const api = createTabHubApi({ fetchImpl });

    await expect(
      api.explainPriority({ type: "page", logicalPageId: 42 }),
    ).rejects.toThrow(
      "TabHub API GET /api/logical-pages/42/priority returned an invalid response",
    );
    await expect(
      api.explainPriority({ type: "resource", resourceId: 9 }),
    ).rejects.toThrow(
      "TabHub API GET /api/resources/9/priority returned an invalid response",
    );
    await expect(
      api.explainPriority({ type: "page", logicalPageId: 42 }),
    ).rejects.toThrow(
      "TabHub API GET /api/logical-pages/42/priority returned an invalid response",
    );
    await expect(
      api.explainPriority({ type: "page", logicalPageId: 42 }),
    ).rejects.toThrow(
      "TabHub API GET /api/logical-pages/42/priority returned an invalid response",
    );
  });

  it("rejects mismatched nested subjects in assessment and exclusion outcomes", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({
        ...pagePriority,
        outcome: {
          kind: "assessment",
          assessment: {
            ...(pagePriority.outcome?.kind === "assessment"
              ? pagePriority.outcome.assessment
              : {}),
            subject: { type: "page", logicalPageId: 43 },
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        ...pagePriority,
        outcome: {
          kind: "assessment",
          assessment: {
            ...(pagePriority.outcome?.kind === "assessment"
              ? pagePriority.outcome.assessment
              : {}),
            subject: { type: "resource", resourceId: 42 },
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        ...resourcePriority,
        outcome: {
          kind: "exclusion",
          exclusion: {
            ...(resourcePriority.outcome?.kind === "exclusion"
              ? resourcePriority.outcome.exclusion
              : {}),
            subject: { type: "resource", resourceId: 10 },
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        ...resourcePriority,
        outcome: {
          kind: "exclusion",
          exclusion: {
            ...(resourcePriority.outcome?.kind === "exclusion"
              ? resourcePriority.outcome.exclusion
              : {}),
            subject: { type: "page", logicalPageId: 9 },
          },
        },
      }));
    const api = createTabHubApi({ fetchImpl });

    for (const subject of [
      { type: "page" as const, logicalPageId: 42 },
      { type: "page" as const, logicalPageId: 42 },
      { type: "resource" as const, resourceId: 9 },
      { type: "resource" as const, resourceId: 9 },
    ]) {
      await expect(api.explainPriority(subject)).rejects.toThrow(
        `TabHub API GET ${subject.type === "page"
          ? "/api/logical-pages/42/priority"
          : "/api/resources/9/priority"} returned an invalid response`,
      );
    }
  });

  it("records page feedback with authorization and replays the same domain result", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse(pageFeedback))
      .mockResolvedValueOnce(jsonResponse(pageFeedback));
    const api = createTabHubApi({ fetchImpl });
    const input = {
      subject: { type: "page" as const, logicalPageId: 42 },
      assessmentId: 71,
      verdict: "too_high" as const,
      note: "The page is no longer part of the current project.",
      idempotencyKey: "priority-feedback-page-42",
      authorizationRef: "user-instruction:priority-review:42",
    };

    await expect(api.recordPriorityFeedback(input)).resolves.toEqual(pageFeedback);
    await expect(api.recordPriorityFeedback(input)).resolves.toEqual(pageFeedback);

    const calls = fetchImpl.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    }));
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:7717/api/agent/logical-pages/42/priority-feedback",
        method: "POST",
        body: {
          assessmentId: 71,
          verdict: "too_high",
          note: "The page is no longer part of the current project.",
          idempotencyKey: "priority-feedback-page-42",
          authorizationRef: "user-instruction:priority-review:42",
        },
      },
      {
        url: "http://127.0.0.1:7717/api/agent/logical-pages/42/priority-feedback",
        method: "POST",
        body: {
          assessmentId: 71,
          verdict: "too_high",
          note: "The page is no longer part of the current project.",
          idempotencyKey: "priority-feedback-page-42",
          authorizationRef: "user-instruction:priority-review:42",
        },
      },
    ]);
    for (const call of calls) {
      expect(call.body).not.toHaveProperty("actor");
      expect(call.body).not.toHaveProperty("method");
      expect(call.body).not.toHaveProperty("model");
      expect(call.body).not.toHaveProperty("ruleset");
      expect(call.body).not.toHaveProperty("featureFingerprint");
      expect(call.body).not.toHaveProperty("schedulingPriority");
      expect(call.body).not.toHaveProperty("budget");
    }
  });

  it("records resource feedback through the typed resource agent route", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(resourceFeedback));
    const api = createTabHubApi({ fetchImpl });

    await expect(api.recordPriorityFeedback({
      subject: { type: "resource", resourceId: 9 },
      assessmentId: 72,
      verdict: "accept",
      idempotencyKey: "priority-feedback-resource-9",
      authorizationRef: "user-instruction:priority-review:resource-9",
    })).resolves.toEqual(resourceFeedback);

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:7717/api/agent/resources/9/priority-feedback",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assessmentId: 72,
          verdict: "accept",
          idempotencyKey: "priority-feedback-resource-9",
          authorizationRef: "user-instruction:priority-review:resource-9",
        }),
      },
    );
  });

  it("rejects feedback receipts that do not exactly correlate to the command", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({
        ...pageFeedback,
        verdict: "accept",
      }))
      .mockResolvedValueOnce(jsonResponse({
        ...pageFeedback,
        note: null,
      }))
      .mockResolvedValueOnce(jsonResponse({
        ...resourceFeedback,
        supersedesId: 17,
      }));
    const api = createTabHubApi({ fetchImpl });

    await expect(api.recordPriorityFeedback({
      subject: { type: "page", logicalPageId: 42 },
      assessmentId: 71,
      verdict: "too_high",
      note: "The page is no longer part of the current project.",
      idempotencyKey: "priority-feedback-verdict-mismatch",
      authorizationRef: "user-instruction:priority-review:42",
    })).rejects.toThrow(
      "TabHub API POST /api/agent/logical-pages/42/priority-feedback returned a mismatched response",
    );
    await expect(api.recordPriorityFeedback({
      subject: { type: "page", logicalPageId: 42 },
      assessmentId: 71,
      verdict: "too_high",
      note: "The page is no longer part of the current project.",
      idempotencyKey: "priority-feedback-note-mismatch",
      authorizationRef: "user-instruction:priority-review:42",
    })).rejects.toThrow(
      "TabHub API POST /api/agent/logical-pages/42/priority-feedback returned a mismatched response",
    );
    await expect(api.recordPriorityFeedback({
      subject: { type: "resource", resourceId: 9 },
      assessmentId: 72,
      verdict: "accept",
      idempotencyKey: "priority-feedback-supersession-mismatch",
      authorizationRef: "user-instruction:priority-review:resource-9",
    })).rejects.toThrow(
      "TabHub API POST /api/agent/resources/9/priority-feedback returned a mismatched response",
    );
  });

  it("sets and clears explicit user importance through the unified typed agent route", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse(pageImportance))
      .mockResolvedValueOnce(jsonResponse(resourceImportance));
    const api = createTabHubApi({ fetchImpl });

    await expect(api.setUserImportance({
      subject: { type: "page", logicalPageId: 42 },
      value: 3,
      authorizationRef: "user-instruction:set-page-importance:42",
      idempotencyKey: "set-page-importance-42",
    })).resolves.toEqual(pageImportance);
    await expect(api.setUserImportance({
      subject: { type: "resource", resourceId: 9 },
      value: null,
      authorizationRef: "user-instruction:clear-resource-importance:9",
      idempotencyKey: "clear-resource-importance-9",
    })).resolves.toEqual(resourceImportance);

    expect(fetchImpl.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    }))).toEqual([
      {
        url: "http://127.0.0.1:7717/api/agent/user-importance",
        method: "PUT",
        body: {
          subject: { type: "page", logicalPageId: 42 },
          value: 3,
          authorizationRef: "user-instruction:set-page-importance:42",
          idempotencyKey: "set-page-importance-42",
        },
      },
      {
        url: "http://127.0.0.1:7717/api/agent/user-importance",
        method: "PUT",
        body: {
          subject: { type: "resource", resourceId: 9 },
          value: null,
          authorizationRef: "user-instruction:clear-resource-importance:9",
          idempotencyKey: "clear-resource-importance-9",
        },
      },
    ]);
  });

  it("replays user importance and rejects spoofed provenance before sending", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse(pageImportance))
      .mockResolvedValueOnce(jsonResponse(pageImportance));
    const api = createTabHubApi({ fetchImpl });
    const input = {
      subject: { type: "page" as const, logicalPageId: 42 },
      value: 3 as const,
      authorizationRef: "user-instruction:set-page-importance:42",
      idempotencyKey: "set-page-importance-42",
    };

    await expect(api.setUserImportance(input)).resolves.toEqual(pageImportance);
    await expect(api.setUserImportance(input)).resolves.toEqual(pageImportance);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const spoofed = {
      ...input,
      actor: "user",
      method: "manual",
      model: { provider: "forbidden" },
      ruleset: { rulesetId: 1, version: 1 },
      featureFingerprint: "f".repeat(64),
      rawFeatures: { localContextBody: privateCanary },
      budget: { maxSteps: 100 },
    };
    await expect(api.setUserImportance(spoofed)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails closed on mismatched or user/manual importance receipts", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({
        ...pageImportance,
        subject: { type: "page", logicalPageId: 43 },
      }))
      .mockResolvedValueOnce(jsonResponse({
        ...pageImportance,
        provenance: { actor: "user", method: "manual" },
      }));
    const api = createTabHubApi({ fetchImpl });
    const input = {
      subject: { type: "page" as const, logicalPageId: 42 },
      value: 3 as const,
      authorizationRef: "user-instruction:set-page-importance:42",
      idempotencyKey: "set-page-importance-42",
    };

    await expect(api.setUserImportance(input)).rejects.toThrow(
      "TabHub API PUT /api/agent/user-importance returned a mismatched response",
    );
    await expect(api.setUserImportance(input)).rejects.toThrow(
      "TabHub API PUT /api/agent/user-importance returned an invalid response",
    );
  });

  it("preserves stable user-importance not-found and conflict failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({
        error: "SUBJECT_NOT_FOUND",
      }, 404))
      .mockResolvedValueOnce(jsonResponse({
        error: "IDEMPOTENCY_KEY_CONFLICT",
      }, 409));
    const api = createTabHubApi({ fetchImpl });

    await expect(api.setUserImportance({
      subject: { type: "page", logicalPageId: 404 },
      value: 3,
      authorizationRef: "user-instruction:set-page-importance:404",
      idempotencyKey: "missing-page-importance",
    })).rejects.toThrow(
      "TabHub API PUT /api/agent/user-importance returned HTTP 404: SUBJECT_NOT_FOUND",
    );
    await expect(api.setUserImportance({
      subject: { type: "resource", resourceId: 9 },
      value: 2,
      authorizationRef: "user-instruction:set-resource-importance:9",
      idempotencyKey: "conflicting-importance-key",
    })).rejects.toThrow(
      "TabHub API PUT /api/agent/user-importance returned HTTP 409: IDEMPOTENCY_KEY_CONFLICT",
    );
  });

  it("never reflects invalid, nested, or oversized REST error details", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({
        error: "private-error-token",
        nested: { code: privateCanary },
      }, 500))
      .mockResolvedValueOnce(jsonResponse({
        code: "VALID_CODE",
        message: privateCanary.repeat(100),
      }, 500));
    const api = createTabHubApi({ fetchImpl });

    const invalidDetailError = await api.explainPriority({
      type: "page",
      logicalPageId: 42,
    }).catch((error: unknown) => error);
    expect(invalidDetailError).toBeInstanceOf(Error);
    expect((invalidDetailError as Error).message).toBe(
      "TabHub API GET /api/logical-pages/42/priority returned HTTP 500",
    );
    expect((invalidDetailError as Error).message).not.toContain(privateCanary);

    const oversizedMessageError = await api.explainPriority({
      type: "page",
      logicalPageId: 42,
    }).catch((error: unknown) => error);
    expect(oversizedMessageError).toBeInstanceOf(Error);
    expect((oversizedMessageError as Error).message).toBe(
      "TabHub API GET /api/logical-pages/42/priority returned HTTP 500: VALID_CODE",
    );
    expect((oversizedMessageError as Error).message).not.toContain(privateCanary);
  });

  it("rejects every control and Unicode line separator in REST error messages", async () => {
    const unsafeMessages = [
      "safe\u0000private",
      "safe\u001fprivate",
      "safe\u007fprivate",
      "safe\u0080private",
      "safe\u009fprivate",
      "safe\u2028private",
      "safe\u2029private",
    ];
    const fetchImpl = vi.fn<typeof fetch>();
    for (const message of unsafeMessages) {
      fetchImpl.mockResolvedValueOnce(jsonResponse({ message }, 500));
    }
    const api = createTabHubApi({ fetchImpl });

    for (const message of unsafeMessages) {
      const error = await api.explainPriority({
        type: "page",
        logicalPageId: 42,
      }).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "TabHub API GET /api/logical-pages/42/priority returned HTTP 500",
      );
      expect((error as Error).message).not.toContain(message);
    }
  });

  it("rejects provenance spoofing before sending feedback", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const api = createTabHubApi({ fetchImpl });
    const spoofed = {
      subject: { type: "page" as const, logicalPageId: 42 },
      assessmentId: 71,
      verdict: "accept" as const,
      idempotencyKey: "priority-feedback-spoof",
      authorizationRef: "user-instruction:priority-review:42",
      actor: "user",
      method: "manual",
      rawFeatures: { localContextBody: privateCanary },
    };

    await expect(api.recordPriorityFeedback(spoofed)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed if an agent feedback route returns user/manual provenance", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({
      ...pageFeedback,
      provenance: { actor: "user", method: "manual" },
    }));
    const api = createTabHubApi({ fetchImpl });

    await expect(api.recordPriorityFeedback({
      subject: { type: "page", logicalPageId: 42 },
      assessmentId: 71,
      verdict: "accept",
      idempotencyKey: "invalid-provenance",
      authorizationRef: "user-instruction:priority-review:42",
    })).rejects.toThrow(
      "TabHub API POST /api/agent/logical-pages/42/priority-feedback returned an invalid response",
    );
  });

  it("preserves stable typed REST not-found and conflict errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl
      .mockResolvedValueOnce(jsonResponse({
        error: "NOT_FOUND",
        code: "PRIORITY_OUTCOME_NOT_FOUND",
        message: "The requested priority outcome was not found",
      }, 404))
      .mockResolvedValueOnce(jsonResponse({
        error: "IDEMPOTENCY_KEY_CONFLICT",
        message: "The priority mutation conflicts with current state",
      }, 409));
    const api = createTabHubApi({ fetchImpl });

    await expect(
      api.explainPriority({ type: "page", logicalPageId: 404 }),
    ).rejects.toThrow(
      "TabHub API GET /api/logical-pages/404/priority returned HTTP 404: PRIORITY_OUTCOME_NOT_FOUND: The requested priority outcome was not found",
    );
    await expect(api.recordPriorityFeedback({
      subject: { type: "page", logicalPageId: 42 },
      assessmentId: 71,
      verdict: "accept",
      idempotencyKey: "conflicting-key",
      authorizationRef: "user-instruction:priority-review:42",
    })).rejects.toThrow(
      "TabHub API POST /api/agent/logical-pages/42/priority-feedback returned HTTP 409: IDEMPOTENCY_KEY_CONFLICT: The priority mutation conflicts with current state",
    );
  });

  it("keeps the public result types pinned to shared contracts", () => {
    const safeRead: PrioritySafeRead = pagePriority;
    const receipt: PriorityFeedbackReceipt = pageFeedback;
    expect(prioritySafeReadSchema.parse(safeRead)).toEqual(pagePriority);
    expect(priorityFeedbackReceiptSchema.parse(receipt)).toEqual(pageFeedback);
  });
});
