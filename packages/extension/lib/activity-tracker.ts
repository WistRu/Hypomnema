export const ACTIVITY_ENGAGEMENT_WINDOW_MS = 60_000;
export const ACTIVITY_MAX_OBSERVATION_GAP_MS = 75_000;

export interface ActivityTarget {
  browserTabId: number;
  url: string;
}

export interface ActivityObservation {
  at: number;
  interaction?: boolean;
  machineActive: boolean;
  target: ActivityTarget | undefined;
}

export interface TrackedActivityInterval extends ActivityTarget {
  engagedMs: number;
  endedAt: number;
  foregroundMs: number;
  startedAt: number;
}

export interface ActivityTrackerCheckpoint {
  engagedUntil: number;
  lastObservedAt: number;
  machineActive: boolean;
  target: ActivityTarget | undefined;
}

export interface ActivityTracker {
  checkpoint(): ActivityTrackerCheckpoint | undefined;
  observe(
    observation: ActivityObservation,
  ): TrackedActivityInterval | undefined;
}

function sameTarget(
  left: ActivityTarget | undefined,
  right: ActivityTarget | undefined,
): boolean {
  return (
    left?.browserTabId === right?.browserTabId && left?.url === right?.url
  );
}

export function isActivityTrackerCheckpoint(
  value: unknown,
): value is ActivityTrackerCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const checkpoint = value as Partial<ActivityTrackerCheckpoint>;
  const target = checkpoint.target;
  return (
    typeof checkpoint.engagedUntil === "number" &&
    Number.isFinite(checkpoint.engagedUntil) &&
    checkpoint.engagedUntil >= 0 &&
    typeof checkpoint.lastObservedAt === "number" &&
    Number.isFinite(checkpoint.lastObservedAt) &&
    checkpoint.lastObservedAt >= 0 &&
    typeof checkpoint.machineActive === "boolean" &&
    (target === undefined ||
      (typeof target === "object" &&
        target !== null &&
        Number.isInteger(target.browserTabId) &&
        target.browserTabId >= 0 &&
        typeof target.url === "string" &&
        target.url.length > 0))
  );
}

export function createActivityTracker(
  checkpoint?: ActivityTrackerCheckpoint,
): ActivityTracker {
  let state: ActivityTrackerCheckpoint | undefined =
    checkpoint === undefined
      ? undefined
      : {
          ...checkpoint,
          target:
            checkpoint.target === undefined
              ? undefined
              : { ...checkpoint.target },
        };

  return {
    checkpoint() {
      return state === undefined
        ? undefined
        : {
            ...state,
            target:
              state.target === undefined ? undefined : { ...state.target },
          };
    },
    observe(observation) {
      if (!Number.isFinite(observation.at) || observation.at < 0) {
        return undefined;
      }

      if (state === undefined) {
        state = {
          engagedUntil:
            observation.interaction === true &&
            observation.machineActive &&
            observation.target !== undefined
              ? observation.at + ACTIVITY_ENGAGEMENT_WINDOW_MS
              : 0,
          lastObservedAt: observation.at,
          machineActive: observation.machineActive,
          target: observation.target,
        };
        return undefined;
      }

      const previous = state;
      const targetChanged = !sameTarget(previous.target, observation.target);
      const monotonicEnd = Math.max(previous.lastObservedAt, observation.at);
      const startedAt = previous.lastObservedAt;
      const observationGapMs = monotonicEnd - startedAt;
      const foregroundMs =
        observationGapMs <= ACTIVITY_MAX_OBSERVATION_GAP_MS &&
        previous.machineActive &&
        previous.target !== undefined
          ? observationGapMs
          : 0;
      const engagedMs =
        foregroundMs === 0
          ? 0
          : Math.max(
              0,
              Math.min(monotonicEnd, previous.engagedUntil) - startedAt,
            );

      state = {
        engagedUntil: targetChanged ? 0 : previous.engagedUntil,
        lastObservedAt: monotonicEnd,
        machineActive: observation.machineActive,
        target: observation.target,
      };

      if (
        observation.interaction === true &&
        observation.machineActive &&
        observation.target !== undefined
      ) {
        state.engagedUntil = monotonicEnd + ACTIVITY_ENGAGEMENT_WINDOW_MS;
      }

      if (foregroundMs === 0 || previous.target === undefined) {
        return undefined;
      }

      return {
        ...previous.target,
        engagedMs,
        endedAt: monotonicEnd,
        foregroundMs,
        startedAt,
      };
    },
  };
}
