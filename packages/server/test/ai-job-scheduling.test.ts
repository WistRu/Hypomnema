import { describe, expect, it } from "vitest";

import {
  chooseNextAiJob,
  type AiJobScheduleCandidate,
  type AiJobScheduleInput,
} from "../src/ai-job-scheduling.js";

const at = "2026-08-13T00:00:00.000Z";

function candidate(
  kind: AiJobScheduleCandidate["kind"],
  id: number,
  schedulingPriority = 0,
  availableAt = at,
  createdAt = at,
): AiJobScheduleCandidate {
  const prefix = kind === "page_summary" ? "summary" : kind;
  return {
    id: `${prefix}:${id}`,
    kind,
    schedulingPriority,
    availableAt,
    createdAt,
  };
}

function input(overrides: Partial<AiJobScheduleInput> = {}): AiJobScheduleInput {
  return {
    cursor: 0,
    eligibleKinds: ["page_summary", "priority_assessment", "resource_research"],
    candidates: [
      candidate("page_summary", 1),
      candidate("priority_assessment", 1),
      candidate("resource_research", 1),
    ],
    usage: {
      page_summary: { running: 0, attemptsUtcDay: 0, costUsdUtcDay: 0 },
      priority_assessment: { running: 0, attemptsUtcDay: 0, costUsdUtcDay: 0 },
      resource_research: { running: 0, attemptsUtcDay: 0, costUsdUtcDay: 0 },
    },
    limits: {
      page_summary: { maxConcurrent: 1, maxAttemptsPerUtcDay: 100,
        maxCostUsdPerUtcDay: null },
      priority_assessment: { maxConcurrent: 1, maxAttemptsPerUtcDay: 100,
        maxCostUsdPerUtcDay: null },
      resource_research: { maxConcurrent: 1, maxAttemptsPerUtcDay: 10,
        maxCostUsdPerUtcDay: 2 },
    },
    ...overrides,
  };
}

describe("AI job scheduling policy", () => {
  it("follows saturated 4:2:1 slots without starving research", () => {
    let cursor = 0;
    const selected: string[] = [];
    for (let index = 0; index < 14; index += 1) {
      const decision = chooseNextAiJob(input({ cursor }));
      expect(decision).not.toBeNull();
      if (decision === null) throw new Error("expected schedule decision");
      selected.push(decision.kind);
      cursor = decision.nextCursorOnSuccessfulClaim;
    }
    expect(selected).toEqual([
      "page_summary", "page_summary", "page_summary", "page_summary",
      "priority_assessment", "priority_assessment", "resource_research",
      "page_summary", "page_summary", "page_summary", "page_summary",
      "priority_assessment", "priority_assessment", "resource_research",
    ]);
  });

  it("borrows unavailable slots and applies every injected kind limit", () => {
    const limits = input().limits;
    expect(chooseNextAiJob(input({
      cursor: 6,
      usage: {
        ...input().usage,
        resource_research: { running: 1, attemptsUtcDay: 0, costUsdUtcDay: 0 },
      },
    }))).toMatchObject({ kind: "page_summary", nextCursorOnSuccessfulClaim: 1 });
    expect(chooseNextAiJob(input({
      cursor: 4,
      usage: {
        page_summary: { running: 1, attemptsUtcDay: 0, costUsdUtcDay: 0 },
        priority_assessment: { running: 0, attemptsUtcDay: 100, costUsdUtcDay: 0 },
        resource_research: { running: 0, attemptsUtcDay: 9, costUsdUtcDay: 2 },
      },
      limits,
    }))).toMatchObject({ kind: "resource_research" });
    expect(chooseNextAiJob(input({
      cursor: 4,
      usage: {
        page_summary: { running: 1, attemptsUtcDay: 0, costUsdUtcDay: 0 },
        priority_assessment: { running: 0, attemptsUtcDay: 100, costUsdUtcDay: 0 },
        resource_research: { running: 0, attemptsUtcDay: 9, costUsdUtcDay: 2.000_001 },
      },
      limits,
    }))).toBeNull();
    expect(chooseNextAiJob(input({
      cursor: 6,
      eligibleKinds: ["page_summary", "priority_assessment"],
    }))).toMatchObject({ kind: "page_summary" });
  });

  it("sorts within a kind by priority, availability, creation, then ID", () => {
    const decision = chooseNextAiJob(input({
      eligibleKinds: ["priority_assessment"],
      candidates: [
        candidate("priority_assessment", 9, 5, "2026-08-13T00:00:02.000Z", at),
        candidate("priority_assessment", 8, 5, "2026-08-13T00:00:01.000Z",
          "2026-08-13T00:00:00.500Z"),
        candidate("priority_assessment", 7, 5, "2026-08-13T00:00:01.000Z", at),
        candidate("priority_assessment", 6, 5, "2026-08-13T00:00:01.000Z", at),
        candidate("priority_assessment", 5, 4, at, at),
      ],
    }));
    expect(decision?.candidate.id).toBe("priority_assessment:6");
    expect(decision?.slotCursor).toBe(4);
    expect(decision?.nextCursorOnSuccessfulClaim).toBe(5);
  });

  it("rejects unsafe counters, mismatched IDs, and duplicate eligible kinds", () => {
    expect(() => chooseNextAiJob(input({ cursor: 7 }))).toThrow();
    expect(() => chooseNextAiJob(input({
      eligibleKinds: ["page_summary", "page_summary"],
    }))).toThrow();
    expect(() => chooseNextAiJob(input({
      candidates: [{ ...candidate("page_summary", 1), id: "priority_assessment:1" }],
    }))).toThrow();
    expect(() => chooseNextAiJob(input({
      usage: {
        ...input().usage,
        page_summary: { running: 0, attemptsUtcDay: 1.5, costUsdUtcDay: 0 },
      },
    }))).toThrow();
  });
});
