import { describe, expect, it, vi } from "vitest";

import { createWorkspaceRestoreLock } from "../src/workspace-restore-lock";

describe("workspace restore submission lock", () => {
  it("rejects an overlapping restore until the first submission settles", async () => {
    let finishFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const firstOperation = vi.fn(() => firstPending);
    const overlappingOperation = vi.fn(async () => undefined);
    const lock = createWorkspaceRestoreLock();

    const first = lock.run(firstOperation);
    await expect(lock.run(overlappingOperation)).resolves.toBe(false);

    expect(firstOperation).toHaveBeenCalledTimes(1);
    expect(overlappingOperation).not.toHaveBeenCalled();

    finishFirst();
    await expect(first).resolves.toBe(true);
  });

  it("allows a later restore after a failed submission", async () => {
    const lock = createWorkspaceRestoreLock();
    const laterOperation = vi.fn(async () => undefined);

    await expect(
      lock.run(async () => {
        throw new Error("Workspace details failed to load");
      }),
    ).rejects.toThrow("Workspace details failed to load");

    await expect(lock.run(laterOperation)).resolves.toBe(true);
    expect(laterOperation).toHaveBeenCalledTimes(1);
  });
});
