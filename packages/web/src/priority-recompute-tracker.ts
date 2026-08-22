import {
  durableJobRefSchema,
  type DurableJobRef,
  type DurableJobStatus,
} from "@tabhub/shared";

export const priorityRecomputeStorageKey =
  "tabhub.priority-recompute.v1" as const;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const terminalStatuses = new Set<DurableJobStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "partial",
  "superseded",
]);

export function createPriorityRecomputeTracker(storage: StorageLike) {
  return {
    remember(job: DurableJobRef): void {
      const parsed = durableJobRefSchema.parse(job);
      if (parsed.kind !== "priority_assessment") {
        throw new Error("Only priority recompute jobs can be tracked");
      }
      storage.setItem(priorityRecomputeStorageKey, JSON.stringify(parsed));
    },
    resume(): DurableJobRef | null {
      const value = storage.getItem(priorityRecomputeStorageKey);
      if (value === null) return null;
      try {
        const parsed = durableJobRefSchema.parse(JSON.parse(value));
        if (parsed.kind !== "priority_assessment" || terminalStatuses.has(parsed.status)) {
          storage.removeItem(priorityRecomputeStorageKey);
          return null;
        }
        return parsed;
      } catch {
        storage.removeItem(priorityRecomputeStorageKey);
        return null;
      }
    },
    observe(status: DurableJobStatus): void {
      if (terminalStatuses.has(status)) storage.removeItem(priorityRecomputeStorageKey);
    },
    clear(): void {
      storage.removeItem(priorityRecomputeStorageKey);
    },
  };
}
