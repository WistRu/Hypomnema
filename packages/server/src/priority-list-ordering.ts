import type { PriorityFeatureRead } from "./priority-feature-catalog.js";
import type { PrioritySubject } from "./priority-engine.js";

export interface PriorityListOrderingReader {
  readBatch(
    subjects: readonly PrioritySubject[],
    anchor?: string,
  ): readonly PriorityFeatureRead[];
  readListProjection?(
    type: "page" | "resource",
    ids: readonly number[],
    anchor: string,
  ): readonly PriorityListSubjectProjection[];
}

export interface PriorityListSubjectProjection {
  readonly subjectId: number;
  readonly bandRank: 0 | 1 | 2 | 3 | 4;
  readonly agentScore: number;
  readonly needsReview: boolean;
}

const bandRanks = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
} as const;

function subjectId(subject: PrioritySubject): number {
  return subject.type === "page" ? subject.logicalPageId : subject.resourceId;
}

function project(read: PriorityFeatureRead): PriorityListSubjectProjection {
  const id = subjectId(read.subject);
  if (!read.isCurrent || read.currentOutcome?.kind !== "assessment") {
    return { subjectId: id, bandRank: 0, agentScore: -1, needsReview: false };
  }
  return {
    subjectId: id,
    bandRank: bandRanks[read.currentOutcome.assessment.agentBand],
    agentScore: read.currentOutcome.assessment.agentScore,
    needsReview: read.currentOutcome.assessment.needsReview,
  };
}

/**
 * Converts the canonical PriorityFeatureCatalog view into the deliberately
 * small projection consumed by page and Resource SQL ordering. Stale,
 * missing, and excluded outcomes are indistinguishable from unranked here.
 */
export function projectPriorityListSubjects(
  reader: PriorityListOrderingReader,
  type: "page" | "resource",
  ids: readonly number[],
  anchor: string,
): readonly PriorityListSubjectProjection[] {
  const unique = new Set<number>();
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id <= 0 || unique.has(id)) {
      throw new Error("Priority list subject IDs must be unique positive integers");
    }
    unique.add(id);
  }
  const result: PriorityListSubjectProjection[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batchIds = ids.slice(offset, offset + 100);
    const subjects: PrioritySubject[] = batchIds.map((id) => type === "page"
      ? { type: "page", logicalPageId: id }
      : { type: "resource", resourceId: id });
    const reads = reader.readBatch(subjects, anchor);
    if (reads.length !== subjects.length) {
      throw new Error("Priority list projection returned the wrong batch length");
    }
    for (let index = 0; index < subjects.length; index += 1) {
      const expected = subjects[index]!;
      const actual = reads[index]!;
      if (actual.subject.type !== expected.type ||
          subjectId(actual.subject) !== subjectId(expected)) {
        throw new Error("Priority list projection returned an out-of-order subject");
      }
      result.push(project(actual));
    }
  }
  return result;
}
