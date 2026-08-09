import { describe, expect, it } from "vitest";

import { createActivationSequencer } from "./activation-sequencer";

describe("activation sequencer", () => {
  it("finishes a delayed first switch before running a fast later switch", async () => {
    const sequencer = createActivationSequencer();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = sequencer.run(async () => {
      events.push("start A");
      await firstGate;
      events.push("focus A");
      return "A";
    });
    const second = sequencer.run(async () => {
      events.push("start B");
      events.push("focus B");
      return "B";
    });

    await Promise.resolve();
    expect(events).toEqual(["start A"]);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(["A", "B"]);
    expect(events).toEqual(["start A", "focus A", "start B", "focus B"]);
  });

  it("continues with the next switch after an earlier switch fails", async () => {
    const sequencer = createActivationSequencer();

    await expect(
      sequencer.run(async () => {
        throw new Error("tab disappeared");
      }),
    ).rejects.toThrow("tab disappeared");
    await expect(sequencer.run(async () => "next tab")).resolves.toBe(
      "next tab",
    );
  });
});
