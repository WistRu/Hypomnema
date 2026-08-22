import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrivacyPurgeRuntime } from "../src/privacy-purge-runtime.js";

const id = `purge_${"a".repeat(64)}`;
const waiting = { version: 1 as const, purgeId: id,
  target: { kind: "logical_page" as const, logicalPageId: 1 }, state: "waiting" as const,
  progress: { completedSteps: 0, totalSteps: 2 }, holdReason: null, canRetry: false,
  timestamps: { createdAt: "2026-08-21T12:00:00.000Z",
    updatedAt: "2026-08-21T12:00:00.000Z", completedAt: null }, result: null };

afterEach(() => vi.useRealTimers());
describe("privacy purge runtime", () => {
  it("recovers active intents, coalesces wakes, and never overlaps", async () => {
    vi.useFakeTimers(); let release!: () => void; let active = 0; let maximum = 0;
    const driveOnce = vi.fn(async () => { active += 1; maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => { release = resolve; }); active -= 1;
      return { status: waiting, progressed: false }; });
    const runtime = createPrivacyPurgeRuntime({ coordinator: { driveOnce },
      listActivePurgeIds: () => [id] });
    runtime.start(); runtime.wake(id); runtime.wake(id);
    await Promise.resolve(); expect(driveOnce).toHaveBeenCalledTimes(1);
    release(); await Promise.resolve(); await Promise.resolve();
    expect(maximum).toBe(1); await runtime.stop();
  });

  it("reschedules progress by one turn and remains dormant without a deadline", async () => {
    vi.useFakeTimers();
    const driveOnce = vi.fn()
      .mockResolvedValueOnce({ status: waiting, progressed: true })
      .mockResolvedValueOnce({ status: waiting, progressed: false });
    const runtime = createPrivacyPurgeRuntime({ coordinator: { driveOnce },
      listActivePurgeIds: () => [id] });
    runtime.start(); await Promise.resolve(); await Promise.resolve();
    expect(driveOnce).toHaveBeenCalledTimes(1);
    await vi.runOnlyPendingTimersAsync(); expect(driveOnce).toHaveBeenCalledTimes(2);
    await vi.runOnlyPendingTimersAsync(); expect(driveOnce).toHaveBeenCalledTimes(2);
    await runtime.stop();
  });

  it("uses the exact durable deadline and rejects invalid/regressed clocks without spin", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
    const errors = vi.fn(); const driveOnce = vi.fn()
      .mockResolvedValueOnce({ status: waiting, progressed: false,
        nextWakeAt: "2026-08-21T12:00:05.000Z" })
      .mockResolvedValueOnce({ status: waiting, progressed: false,
        nextWakeAt: "bad" });
    const runtime = createPrivacyPurgeRuntime({ coordinator: { driveOnce },
      listActivePurgeIds: () => [id], clock: () => new Date(), onError: errors });
    runtime.start(); await Promise.resolve(); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(4_999); expect(driveOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(driveOnce).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenCalledWith("PURGE_RUNTIME_CLOCK_INVALID");
    await vi.runOnlyPendingTimersAsync(); expect(driveOnce).toHaveBeenCalledTimes(2);
    await runtime.stop();

    const regressedDrive = vi.fn(async () => ({ status: waiting, progressed: false,
      nextWakeAt: "2026-08-21T11:59:59.999Z" }));
    const regressed = createPrivacyPurgeRuntime({ coordinator: { driveOnce: regressedDrive },
      listActivePurgeIds: () => [id], clock: () => new Date(), onError: errors });
    regressed.start(); await Promise.resolve(); await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();
    expect(regressedDrive).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenLastCalledWith("PURGE_RUNTIME_UNAVAILABLE");
    await vi.runOnlyPendingTimersAsync(); expect(regressedDrive).toHaveBeenCalledTimes(2);
    await regressed.stop();
  });

  it("stop clears timers, rejects new wakes, and awaits in-flight work", async () => {
    vi.useFakeTimers(); let release!: () => void;
    const driveOnce = vi.fn(async () => { await new Promise<void>((r) => { release = r; });
      return { status: waiting, progressed: true }; });
    const runtime = createPrivacyPurgeRuntime({ coordinator: { driveOnce },
      listActivePurgeIds: () => [id] });
    runtime.start(); await Promise.resolve(); const stopping = runtime.stop();
    runtime.wake(id); release(); await stopping; await vi.runAllTimersAsync();
    expect(driveOnce).toHaveBeenCalledTimes(1);
  });
});
