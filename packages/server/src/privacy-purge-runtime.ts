import type { PrivacyPurgeCoordinator } from "./privacy-purge-coordinator.js";

export interface PrivacyPurgeRuntimeOptions {
  readonly coordinator: Pick<PrivacyPurgeCoordinator, "driveOnce">;
  readonly listActivePurgeIds: () => readonly string[];
  readonly clock?: () => Date;
  readonly onError?: (code: "PURGE_RUNTIME_UNAVAILABLE" | "PURGE_RUNTIME_CLOCK_INVALID") => void;
}

export interface PrivacyPurgeRuntime {
  start(): void;
  wake(purgeId?: string): void;
  stop(): Promise<void>;
}

export function createPrivacyPurgeRuntime(options: PrivacyPurgeRuntimeOptions): PrivacyPurgeRuntime {
  const clock = options.clock ?? (() => new Date());
  const pending = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const immediateDeadlineAttempts = new Map<string, string>();
  let active: Promise<void> | undefined;
  let started = false;
  let stopping = false;

  const clearWake = (purgeId: string) => {
    const timer = timers.get(purgeId);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(purgeId);
  };
  const schedule = (purgeId: string, at?: string) => {
    if (stopping) return;
    clearWake(purgeId);
    let delay = 0;
    if (at !== undefined) {
      const now = clock().getTime();
      const target = Date.parse(at);
      if (!Number.isFinite(now) || !Number.isFinite(target)) {
        options.onError?.("PURGE_RUNTIME_CLOCK_INVALID");
        return;
      }
      if (target <= now) {
        if (immediateDeadlineAttempts.get(purgeId) === at) {
          options.onError?.("PURGE_RUNTIME_UNAVAILABLE");
          return;
        }
        immediateDeadlineAttempts.set(purgeId, at);
        delay = 0;
      } else {
        immediateDeadlineAttempts.delete(purgeId);
        delay = target - now;
      }
    } else {
      immediateDeadlineAttempts.delete(purgeId);
    }
    const timer = setTimeout(() => {
      timers.delete(purgeId);
      wake(purgeId);
    }, delay);
    timer.unref();
    timers.set(purgeId, timer);
  };
  const drain = async () => {
    const purgeId = pending.values().next().value as string | undefined;
    if (purgeId === undefined || stopping) return;
    pending.delete(purgeId);
    try {
      const result = await options.coordinator.driveOnce(purgeId);
      const terminal = result.status.state === "completed" || result.status.state === "failed";
      if (!terminal && result.progressed) schedule(purgeId);
      else if (!terminal && result.nextWakeAt !== undefined) schedule(purgeId, result.nextWakeAt);
    } catch {
      options.onError?.("PURGE_RUNTIME_UNAVAILABLE");
    }
  };
  const ensureDrain = () => {
    if (active !== undefined || stopping || pending.size === 0) return;
    active = drain().finally(() => {
      active = undefined;
      if (pending.size > 0 && !stopping) ensureDrain();
    });
  };
  function wake(purgeId?: string): void {
    if (!started || stopping) return;
    if (purgeId === undefined) {
      try { for (const id of options.listActivePurgeIds()) pending.add(id); }
      catch { options.onError?.("PURGE_RUNTIME_UNAVAILABLE"); return; }
    } else {
      clearWake(purgeId);
      pending.add(purgeId);
    }
    ensureDrain();
  }
  return Object.freeze({
    start() {
      if (started || stopping) return;
      started = true;
      wake();
    },
    wake,
    async stop() {
      stopping = true;
      pending.clear();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await active;
    },
  });
}
