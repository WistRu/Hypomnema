import { describe, expect, it, vi } from "vitest";

import { registerTabEventSnapshots } from "./tab-event-snapshots";

describe("tab event snapshots", () => {
  it("schedules refreshes for create/update/remove and location or protection changes", () => {
    const listeners = new Map<string, () => void>();
    const registrar = (name: string) => (listener: () => void) => {
      listeners.set(name, listener);
    };
    const schedule = vi.fn();

    registerTabEventSnapshots(schedule, {
      activated: registrar("activated"),
      attached: registrar("attached"),
      created: registrar("created"),
      detached: registrar("detached"),
      moved: registrar("moved"),
      removed: registrar("removed"),
      replaced: registrar("replaced"),
      updated: registrar("updated"),
    });

    for (const listener of listeners.values()) listener();

    expect([...listeners.keys()]).toEqual([
      "created",
      "updated",
      "removed",
      "replaced",
      "activated",
      "moved",
      "attached",
      "detached",
    ]);
    expect(schedule).toHaveBeenCalledTimes(8);
  });
});
