import { describe, expect, it } from "vitest";

import {
  closeUndoIsDismissed,
  dismissCloseUndos,
} from "../src/close-undo-dismissals";
import type { PhysicalTabScope } from "../src/extension-bridge";

const chromeScope: PhysicalTabScope = {
  browser: "chrome",
  browserSessionId: "123e4567-e89b-42d3-a456-426614174000",
  installationId: "223e4567-e89b-42d3-a456-426614174000",
};

describe("close Undo report dismissals", () => {
  it("hides only the acknowledged scope's Undo without mutating prior state", () => {
    const prior = new Set<string>();
    const dismissed = dismissCloseUndos(prior, [
      { scope: chromeScope, undoId: "323e4567-e89b-42d3-a456-426614174000" },
    ]);
    const otherScope = { ...chromeScope, browser: "edge" };

    expect(prior.size).toBe(0);
    expect(
      closeUndoIsDismissed(dismissed, {
        scope: chromeScope,
        undoId: "323e4567-e89b-42d3-a456-426614174000",
      }),
    ).toBe(true);
    expect(
      closeUndoIsDismissed(dismissed, {
        scope: otherScope,
        undoId: "323e4567-e89b-42d3-a456-426614174000",
      }),
    ).toBe(false);
  });
});
