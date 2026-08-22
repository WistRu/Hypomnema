import { describe, expect, it } from "vitest";

import type { PriorityFeatureRead } from "../src/priority-feature-catalog.js";
import { projectPriorityListSubjects } from "../src/priority-list-ordering.js";

const fingerprint = "a".repeat(64);
const at = "2026-08-13T12:00:00.000Z";

function read(
  id: number,
  kind: "current" | "stale" | "exclusion" | "missing",
): PriorityFeatureRead {
  const subject = { type: "page" as const, logicalPageId: id };
  const assessment = {
    id,
    subject,
    agentScore: id % 101,
    agentBand: "high" as const,
    confidence: 0.9,
    needsReview: id % 2 === 0,
    reasons: [],
    missingSignals: [],
    ruleset: { rulesetId: 1, version: 1 },
    featureFingerprint: fingerprint,
    assessmentMethod: "rule" as const,
    modelProvenance: null,
    revision: 1,
    evaluatedAt: at,
    supersededAt: null,
  };
  return {
    subject,
    features: {},
    eligibility: { kind: "eligible" },
    featureFingerprint: fingerprint,
    ruleset: { rulesetId: 1, version: 1 },
    desiredAssessmentMethod: "rule",
    currentOutcome: kind === "missing"
      ? null
      : kind === "exclusion"
        ? {
            kind: "exclusion",
            exclusion: {
              id,
              subject,
              reason: "policy_excluded",
              detail: {},
              ruleset: { rulesetId: 1, version: 1 },
              featureFingerprint: fingerprint,
              revision: 1,
              evaluatedAt: at,
              supersededAt: null,
            },
          }
        : { kind: "assessment", assessment },
    isCurrent: kind === "current" || kind === "exclusion",
    dirty: kind === "stale" || kind === "missing",
    needsReview: false,
  };
}

describe("priority list ordering projection", () => {
  it("batches canonical reads and exposes only current assessment order fields", () => {
    const calls: number[][] = [];
    const kinds = new Map<number, Parameters<typeof read>[1]>([
      [1, "current"],
      [2, "stale"],
      [3, "exclusion"],
      [4, "missing"],
    ]);
    const reader = {
      readBatch(subjects: readonly { type: "page"; logicalPageId: number }[]) {
        calls.push(subjects.map((subject) => subject.logicalPageId));
        return subjects.map((subject) => read(
          subject.logicalPageId,
          kinds.get(subject.logicalPageId) ?? "current",
        ));
      },
    };
    const result = projectPriorityListSubjects(
      reader,
      "page",
      Array.from({ length: 205 }, (_, index) => index + 1),
      at,
    );

    expect(calls.map((call) => call.length)).toEqual([100, 100, 5]);
    expect(result.slice(0, 4)).toEqual([
      { subjectId: 1, bandRank: 3, agentScore: 1, needsReview: false },
      { subjectId: 2, bandRank: 0, agentScore: -1, needsReview: false },
      { subjectId: 3, bandRank: 0, agentScore: -1, needsReview: false },
      { subjectId: 4, bandRank: 0, agentScore: -1, needsReview: false },
    ]);
  });

  it("maps every current band, Resource identity, and assessment-only review truth", () => {
    const scores = [10, 40, 70, 90];
    const pageReader = {
      readBatch(subjects: readonly { type: "page"; logicalPageId: number }[]) {
        return subjects.map((subject, index) => {
          const value = read(subject.logicalPageId, "current");
          if (value.currentOutcome?.kind !== "assessment") throw new Error("test setup");
          const score = scores[index]!;
          return { ...value, needsReview: true, currentOutcome: {
            kind: "assessment" as const,
            assessment: { ...value.currentOutcome.assessment,
              agentScore: score,
              agentBand: (["low", "medium", "high", "critical"] as const)[index]!,
              needsReview: index === 3 },
          } };
        });
      },
    };
    expect(projectPriorityListSubjects(pageReader, "page", [1, 2, 3, 4], at))
      .toEqual([
        { subjectId: 1, bandRank: 1, agentScore: 10, needsReview: false },
        { subjectId: 2, bandRank: 2, agentScore: 40, needsReview: false },
        { subjectId: 3, bandRank: 3, agentScore: 70, needsReview: false },
        { subjectId: 4, bandRank: 4, agentScore: 90, needsReview: true },
      ]);

    const resourceRead = read(9, "current");
    const resourceReader = { readBatch: () => [{ ...resourceRead,
      subject: { type: "resource" as const, resourceId: 9 },
      currentOutcome: resourceRead.currentOutcome?.kind === "assessment"
        ? { kind: "assessment" as const, assessment: {
            ...resourceRead.currentOutcome.assessment,
            subject: { type: "resource" as const, resourceId: 9 },
          } }
        : null }] };
    expect(projectPriorityListSubjects(resourceReader, "resource", [9], at)[0])
      .toMatchObject({ subjectId: 9, bandRank: 3 });
  });

  it("rejects malformed IDs and out-of-order reader results", () => {
    const reader = { readBatch: () => [read(2, "current")] };
    expect(() => projectPriorityListSubjects(reader, "page", [1], at))
      .toThrow("out-of-order subject");
    expect(() => projectPriorityListSubjects(reader, "page", [1, 1], at))
      .toThrow("unique positive integers");
    expect(() => projectPriorityListSubjects({ readBatch: () => [] },
      "page", [1], at)).toThrow("wrong batch length");
  });

  it("keeps equal numeric page and Resource identities type-scoped", () => {
    const calls: Array<{ type: "page" | "resource"; id: number }> = [];
    const reader = {
      readBatch(subjects: readonly ({ type: "page"; logicalPageId: number } |
        { type: "resource"; resourceId: number })[]) {
        return subjects.map((subject) => {
          calls.push({ type: subject.type, id: subject.type === "page"
            ? subject.logicalPageId : subject.resourceId });
          const value = read(7, "current");
          return subject.type === "page" ? value : {
            ...value,
            subject: { type: "resource" as const, resourceId: 7 },
            currentOutcome: value.currentOutcome?.kind === "assessment"
              ? { kind: "assessment" as const, assessment: {
                  ...value.currentOutcome.assessment,
                  subject: { type: "resource" as const, resourceId: 7 },
                } }
              : null,
          };
        });
      },
    };
    expect(projectPriorityListSubjects(reader, "page", [7], at)[0]?.subjectId)
      .toBe(7);
    expect(projectPriorityListSubjects(reader, "resource", [7], at)[0]?.subjectId)
      .toBe(7);
    expect(calls).toEqual([{ type: "page", id: 7 },
      { type: "resource", id: 7 }]);

    expect(() => projectPriorityListSubjects({ readBatch: () => [{
      ...read(7, "current"), subject: { type: "resource" as const, resourceId: 7 },
    }] }, "page", [7], at)).toThrow("out-of-order subject");
    expect(() => projectPriorityListSubjects({ readBatch: () => [read(7, "current")] },
      "resource", [7], at)).toThrow("out-of-order subject");
  });
});
