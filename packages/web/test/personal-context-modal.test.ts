/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";

import { activateModalDialog } from "../src/modal-dialog";

afterEach(() => {
  document.body.replaceChildren();
});

describe("personal context modal keyboard boundary", () => {
  it("includes textarea in initial focus and the complete focus cycle", () => {
    const trigger = document.createElement("button");
    const dialog = document.createElement("aside");
    const textarea = document.createElement("textarea");
    const finish = document.createElement("button");
    dialog.append(textarea, finish);
    document.body.append(trigger, dialog);
    trigger.focus();
    const dismiss = vi.fn();

    const deactivate = activateModalDialog(dialog, trigger, dismiss);
    expect(document.activeElement).toBe(textarea);

    finish.focus();
    finish.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
    expect(document.activeElement).toBe(textarea);

    dialog.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    expect(dismiss).toHaveBeenCalledOnce();
    deactivate();
    expect(document.activeElement).toBe(trigger);
  });
});
