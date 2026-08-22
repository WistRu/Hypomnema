import type {
  PriorityFeedbackReceipt,
  PrioritySafeRead,
  PrioritySubjectContract,
} from "@tabhub/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchPriorityReadBatch,
  fetchPriorityReviewQueue,
  resetLocalSessionBootstrapForTests,
  submitPriorityFeedback,
} from "../src/api";

const evaluatedAt = "2026-08-13T10:00:00.000Z";
const fingerprint = "a".repeat(64);

function safeRead(subject: PrioritySubjectContract): PrioritySafeRead {
  return {
    subject,
    outcome: {
      kind: "assessment",
      assessment: {
        id: subject.type === "page" ? subject.logicalPageId : subject.resourceId,
        subject,
        agentScore: 78,
        agentBand: "high",
        confidence: 0.8,
        needsReview: false,
        reasons: [],
        missingSignals: [],
        ruleset: { rulesetId: 1, version: 1 },
        featureFingerprint: fingerprint,
        assessmentMethod: "rule",
        modelProvenance: null,
        revision: 1,
        evaluatedAt,
        supersededAt: null,
      },
    },
    isCurrent: true,
    dirty: false,
    needsReview: false,
  };
}

function feedback(subject: PrioritySubjectContract): PriorityFeedbackReceipt {
  return {
    id: 90,
    subject,
    assessmentId: 17,
    verdict: "too_low",
    note: null,
    provenance: { actor: "user", method: "manual" },
    supersedesId: null,
    supersededAt: null,
    revision: 1,
    createdAt: evaluatedAt,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetLocalSessionBootstrapForTests();
});

describe("priority API", () => {
  it("chunks bounded reads at 100, preserves order, and never performs per-row GETs", async () => {
    const subjects: PrioritySubjectContract[] = Array.from(
      { length: 201 },
      (_, index) =>
        index % 2 === 0
          ? { type: "page", logicalPageId: index + 1 }
          : { type: "resource", resourceId: index + 1 },
    );
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { subjects: PrioritySubjectContract[] };
      return Response.json({ items: body.subjects.map(safeRead) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPriorityReadBatch(subjects);

    expect(result.map(({ subject }) => subject)).toEqual(subjects);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/personalization/priority/read-batch",
      "/api/personalization/priority/read-batch",
      "/api/personalization/priority/read-batch",
    ]);
    expect(fetchMock.mock.calls.map(([, init]) =>
      (JSON.parse(String(init?.body)) as { subjects: unknown[] }).subjects.length,
    )).toEqual([100, 100, 1]);
  });

  it("rejects truncated, reordered, and wrong-subject batch replies", async () => {
    const subjects: PrioritySubjectContract[] = [
      { type: "page", logicalPageId: 17 },
      { type: "resource", resourceId: 22 },
    ];
    for (const items of [
      [safeRead(subjects[0]!)],
      [safeRead(subjects[1]!), safeRead(subjects[0]!)],
      [safeRead({ type: "page", logicalPageId: 999 }), safeRead(subjects[1]!)],
    ]) {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ items })));
      await expect(fetchPriorityReadBatch(subjects)).rejects.toThrow(
        "TabHub returned mismatched AI priority.",
      );
    }
  });

  it("reads an opaque paginated review cursor for mixed page and Resource subjects", async () => {
    const page = safeRead({ type: "page", logicalPageId: 17 });
    const resource = safeRead({ type: "resource", resourceId: 22 });
    const fetchMock = vi.fn(async () => Response.json({
      items: [page, resource],
      nextCursor: "opaque+cursor/2=",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPriorityReviewQueue({
      cursor: "opaque+cursor/1=",
      limit: 2,
    })).resolves.toEqual({ items: [page, resource], nextCursor: "opaque+cursor/2=" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/personalization/priority/review-queue?limit=2&cursor=opaque%2Bcursor%2F1%3D",
    );
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("method");
  });

  it("reuses the caller's idempotency key for a safe feedback retry without provenance fields", async () => {
    const subject = { type: "page" as const, logicalPageId: 17 };
    let attempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/api/local/session/bootstrap") return new Response(null, { status: 404 });
      attempts += 1;
      if (attempts === 1) return Response.json({ error: "temporary" }, { status: 503 });
      return Response.json(feedback(subject));
    });
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      assessmentId: 17,
      idempotencyKey: "priority-feedback:stable-retry-key",
      verdict: "too_low" as const,
    };

    await expect(submitPriorityFeedback(subject, input)).rejects.toThrow();
    await expect(submitPriorityFeedback(subject, input)).resolves.toMatchObject({
      provenance: { actor: "user", method: "manual" },
      subject,
    });

    const mutations = fetchMock.mock.calls.filter(([path]) =>
      path === "/api/logical-pages/17/priority-feedback",
    );
    expect(mutations).toHaveLength(2);
    for (const [, init] of mutations) {
      expect(JSON.parse(String(init?.body))).toEqual(input);
      expect(String(init?.body)).not.toMatch(/actor|method|provenance/);
    }
  });

  it("uses the typed Resource feedback route and rejects cross-subject receipts", async () => {
    const subject = { type: "resource" as const, resourceId: 22 };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      input === "/api/local/session/bootstrap"
        ? new Response(null, { status: 404 })
        : Response.json(feedback({ type: "page", logicalPageId: 22 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitPriorityFeedback(subject, {
      assessmentId: 17,
      idempotencyKey: "resource-feedback",
      verdict: "accept",
    })).rejects.toThrow("TabHub returned mismatched priority feedback.");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/resources/22/priority-feedback");
  });

  it("accepts a correlated local Resource feedback receipt", async () => {
    const subject = { type: "resource" as const, resourceId: 22 };
    const receipt = {
      ...feedback(subject),
      verdict: "accept" as const,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      input === "/api/local/session/bootstrap"
        ? new Response(null, { status: 404 })
        : Response.json(receipt),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitPriorityFeedback(subject, {
      assessmentId: 17,
      idempotencyKey: "resource-feedback-success",
      verdict: "accept",
    })).resolves.toEqual(receipt);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/resources/22/priority-feedback");
  });

  it("rejects caller-selected feedback provenance before any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitPriorityFeedback(
      { type: "page", logicalPageId: 17 },
      {
        assessmentId: 17,
        idempotencyKey: "no-caller-provenance",
        verdict: "accept",
        actor: "agent",
        method: "on_behalf_of_user",
      } as never,
    )).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["assessment", { assessmentId: 18 }],
    ["verdict", { verdict: "too_high" }],
    ["note", { note: "different" }],
    ["supersession", { supersedesId: 90 }],
  ])("rejects a same-subject feedback receipt with mismatched %s", async (_name, change) => {
    const subject = { type: "page" as const, logicalPageId: 17 };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      input === "/api/local/session/bootstrap"
        ? new Response(null, { status: 404 })
        : Response.json({ ...feedback(subject), ...change }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitPriorityFeedback(subject, {
      assessmentId: 17,
      idempotencyKey: "correlation-check",
      verdict: "too_low",
    })).rejects.toThrow("TabHub returned mismatched priority feedback.");
  });
});
