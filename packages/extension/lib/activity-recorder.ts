import type { IngestActivity } from "@tabhub/shared";

import {
  createActivityTracker,
  type ActivityObservation,
  type ActivityTracker,
  type ActivityTrackerCheckpoint,
} from "./activity-tracker";
import type { KnownBrowser } from "./storage";

export interface ActivityRecorderScope {
  browser: KnownBrowser;
  browserSessionId: string;
  installationId: string;
}

export interface ScopedActivityRecorderCheckpoint
  extends ActivityRecorderScope {
  sequence: number;
  tracker: ActivityTrackerCheckpoint;
}

export interface ActivityRecorderDependencies {
  load(): Promise<ScopedActivityRecorderCheckpoint | undefined>;
  persist(
    checkpoint: ScopedActivityRecorderCheckpoint,
    activity: IngestActivity | undefined,
  ): Promise<void>;
  randomUUID(): string;
}

export interface ActivityRecorder {
  observe(
    scope: ActivityRecorderScope,
    observation: ActivityObservation,
  ): Promise<void>;
}

function sameScope(
  left: ActivityRecorderScope | undefined,
  right: ActivityRecorderScope,
): boolean {
  return (
    sameStream(left, right) && left?.browser === right.browser
  );
}

function sameStream(
  left: ActivityRecorderScope | undefined,
  right: ActivityRecorderScope,
): boolean {
  return (
    left?.browserSessionId === right.browserSessionId &&
    left?.installationId === right.installationId
  );
}

export function createActivityRecorder(
  dependencies: ActivityRecorderDependencies,
): ActivityRecorder {
  let currentScope: ActivityRecorderScope | undefined;
  let sequence = 0;
  let tracker: ActivityTracker | undefined;
  let tail: Promise<void> = Promise.resolve();

  const observe = async (
    scope: ActivityRecorderScope,
    observation: ActivityObservation,
  ): Promise<void> => {
    if (!sameScope(currentScope, scope) || tracker === undefined) {
      const stored = await dependencies.load();
      const matchingStream =
        stored !== undefined && sameStream(stored, scope) ? stored : undefined;
      tracker = createActivityTracker(
        matchingStream !== undefined && sameScope(matchingStream, scope)
          ? matchingStream.tracker
          : undefined,
      );
      sequence = matchingStream?.sequence ?? 0;
      currentScope = { ...scope };
    }

    const interval = tracker.observe(observation);
    const checkpoint = tracker.checkpoint();
    if (checkpoint === undefined) return;
    let activity: IngestActivity | undefined;
    if (interval !== undefined) {
      if (sequence >= Number.MAX_SAFE_INTEGER) {
        throw new Error("Tab activity sequence is exhausted");
      }
      sequence += 1;
      activity = {
        id: dependencies.randomUUID(),
        ...scope,
        browserTabId: interval.browserTabId,
        sequence,
        url: interval.url,
        startedAt: new Date(interval.startedAt).toISOString(),
        endedAt: new Date(interval.endedAt).toISOString(),
        foregroundMs: interval.foregroundMs,
        engagedMs: interval.engagedMs,
      };
    }

    await dependencies.persist(
      { ...scope, sequence, tracker: checkpoint },
      activity,
    );
  };

  return {
    observe(scope, observation) {
      const operation = tail.then(
        () => observe(scope, observation),
        () => observe(scope, observation),
      );
      tail = operation.catch(() => undefined);
      return operation;
    },
  };
}
