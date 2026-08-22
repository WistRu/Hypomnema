import {
  AI_JOB_SATURATED_CYCLE,
  type AiJobScheduleKind,
} from "./ai-job-scheduling.js";
import type {
  AiJobClaimBoundary,
  AiJobRuntimeCursorStore,
} from "./ai-job-runtime-state.js";

export interface AiJobRuntimeExecution {
  readonly id: string;
  execute(): void | Promise<void>;
}

export interface AiJobRuntimePhysicalAdapter {
  readonly kind: AiJobScheduleKind;
  recoverInterrupted(): number;
  claim(boundary: AiJobClaimBoundary): AiJobRuntimeExecution | undefined;
  stop?(): void | Promise<void>;
}

export interface AiJobRuntimeOptions {
  readonly cursorStore: AiJobRuntimeCursorStore;
  readonly adapters: readonly AiJobRuntimePhysicalAdapter[];
  readonly pollMs?: number;
  readonly onError?: (error: unknown) => void;
}

export interface AiJobRuntime {
  start(): void;
  wake(): void;
  drainAvailable(): Promise<number>;
  stop(): Promise<void>;
}

function validatePollMs(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("AI job runtime pollMs must be a positive integer");
  }
  return value;
}

/**
 * Owns only orchestration. Cursor persistence belongs to the successful
 * physical claim transaction, so a runtime crash can neither skip nor replay a
 * scheduling slot through a separate state write.
 */
export function createAiJobRuntime(options: AiJobRuntimeOptions): AiJobRuntime {
  const pollMs = validatePollMs(options.pollMs ?? 1_000);
  const adapters = new Map<AiJobScheduleKind, AiJobRuntimePhysicalAdapter>();
  for (const adapter of options.adapters) {
    if (adapters.has(adapter.kind)) {
      throw new Error(`Duplicate AI job runtime adapter: ${adapter.kind}`);
    }
    adapters.set(adapter.kind, adapter);
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  let activeDrain: Promise<number> | undefined;
  let stopping = false;
  let recoveryRequired = true;

  function recoverAll(): void {
    for (const adapter of adapters.values()) adapter.recoverInterrupted();
    recoveryRequired = false;
  }

  function claimNext(): AiJobRuntimeExecution | undefined {
    const cursor = options.cursorStore.read();
    const tried = new Set<AiJobScheduleKind>();
    for (let offset = 0; offset < AI_JOB_SATURATED_CYCLE.length; offset += 1) {
      const slot = (cursor + offset) % AI_JOB_SATURATED_CYCLE.length;
      const kind = AI_JOB_SATURATED_CYCLE[slot]!;
      if (tried.has(kind)) continue;
      tried.add(kind);
      const adapter = adapters.get(kind);
      if (adapter === undefined) continue;
      const claim = adapter.claim({
        nextCursor: ((slot + 1) % AI_JOB_SATURATED_CYCLE.length) as
          AiJobClaimBoundary["nextCursor"],
      });
      if (claim !== undefined) return claim;
    }
    return undefined;
  }

  async function drain(): Promise<number> {
    let processed = 0;
    if (recoveryRequired) recoverAll();
    while (!stopping) {
      let claim: AiJobRuntimeExecution | undefined;
      try {
        claim = claimNext();
      } catch (error) {
        options.onError?.(error);
        return processed;
      }
      if (claim === undefined) return processed;
      try {
        await claim.execute();
      } catch (error) {
        options.onError?.(error);
      }
      processed += 1;
    }
    return processed;
  }

  function drainAvailable(): Promise<number> {
    if (stopping) return Promise.resolve(0);
    if (activeDrain !== undefined) return activeDrain;
    activeDrain = drain().finally(() => {
      activeDrain = undefined;
      recoveryRequired = true;
    });
    return activeDrain;
  }

  function wake(): void {
    if (stopping) return;
    void drainAvailable().catch((error: unknown) => options.onError?.(error));
  }

  return {
    start() {
      if (timer !== undefined) return;
      stopping = false;
      // Validate durable state before recovery can mutate either physical ledger.
      options.cursorStore.read();
      recoverAll();
      timer = setInterval(wake, pollMs);
      timer.unref();
      wake();
    },

    wake,
    drainAvailable,

    async stop() {
      stopping = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      await Promise.all([...adapters.values()].map(async (adapter) => adapter.stop?.()));
      await activeDrain;
    },
  };
}
