import { describe, expect, it, vi } from "vitest";
import { startRuntimeStack, stopRuntimeStack, wakeAfterC90Settlement } from
  "../src/privacy-purge-app-lifecycle.js";

describe("privacy purge app lifecycle ordering", () => {
  it("starts after epoch recovery and before the AI runtime", () => {
    const order: string[] = [];
    startRuntimeStack(() => order.push("epoch"),
      { start: () => { order.push("purge"); } },
      { start: () => { order.push("ai"); } });
    expect(order).toEqual(["epoch", "purge", "ai"]);
  });

  it("wakes purge and AI recovery after C90 settlement", () => {
    const order: string[] = [];
    wakeAfterC90Settlement({ wake: () => { order.push("purge"); } },
      { wake: () => { order.push("ai"); } });
    expect(order).toEqual(["purge", "ai"]);
  });

  it("awaits purge then AI shutdown before closing the database", async () => {
    const order: string[] = []; let release!: () => void;
    const purge = { stop: vi.fn(() => new Promise<void>((resolve) => {
      release = () => { order.push("purge"); resolve(); };
    })) };
    const ai = { stop: vi.fn(async () => { order.push("ai"); }) };
    const stopping = stopRuntimeStack(purge, ai, () => { order.push("db"); });
    await Promise.resolve(); expect(ai.stop).not.toHaveBeenCalled();
    release(); await stopping;
    expect(order).toEqual(["purge", "ai", "db"]);
  });
});

