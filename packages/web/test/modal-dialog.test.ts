import { describe, expect, it, vi } from "vitest";

import {
  activateModalDialog,
  shouldDismissAfterConfirmedAction,
} from "../src/modal-dialog";

interface FakeDocument {
  activeElement: FakeElement | null;
}

class FakeElement {
  private keydown: ((event: KeyboardEvent) => void) | undefined;
  disabled = false;
  isConnected = true;

  constructor(
    readonly ownerDocument: FakeDocument,
    private readonly children: FakeElement[] = [],
  ) {}

  addEventListener(type: string, listener: (event: KeyboardEvent) => void) {
    if (type === "keydown") this.keydown = listener;
  }

  contains(value: unknown) {
    return value === this || this.children.includes(value as FakeElement);
  }

  dispatchKey(key: string, shiftKey = false) {
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    this.keydown?.({ key, preventDefault, shiftKey, stopPropagation } as unknown as KeyboardEvent);
    return { preventDefault, stopPropagation };
  }

  focus() {
    if (this.disabled || !this.isConnected) return;
    this.ownerDocument.activeElement = this;
  }

  querySelectorAll() {
    return this.children;
  }

  removeEventListener(type: string) {
    if (type === "keydown") this.keydown = undefined;
  }
}

describe("modal dialog focus", () => {
  it("keeps a confirmed dialog mounted until its async action succeeds", () => {
    expect(shouldDismissAfterConfirmedAction(true, "pending")).toBe(false);
    expect(shouldDismissAfterConfirmedAction(true, "error")).toBe(false);
    expect(shouldDismissAfterConfirmedAction(true, "success")).toBe(true);
    expect(shouldDismissAfterConfirmedAction(false, "success")).toBe(false);
  });

  it("traps forward and reverse tab, dismisses on Escape, and restores its trigger", () => {
    const document: FakeDocument = { activeElement: null };
    const trigger = new FakeElement(document);
    const cancel = new FakeElement(document);
    const confirm = new FakeElement(document);
    const dialog = new FakeElement(document, [cancel, confirm]);
    const dismiss = vi.fn();

    const deactivate = activateModalDialog(
      dialog as unknown as HTMLElement,
      trigger as unknown as HTMLElement,
      dismiss,
    );
    expect(document.activeElement).toBe(cancel);

    confirm.focus();
    expect(dialog.dispatchKey("Tab").preventDefault).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(cancel);

    cancel.focus();
    expect(dialog.dispatchKey("Tab", true).preventDefault).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(confirm);

    const escape = dialog.dispatchKey("Escape");
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(escape.stopPropagation).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();

    deactivate();
    expect(document.activeElement).toBe(trigger);
  });

  it("restores focus to a live result when the trigger is no longer focusable", () => {
    const document: FakeDocument = { activeElement: null };
    const trigger = new FakeElement(document);
    const cancel = new FakeElement(document);
    const result = new FakeElement(document);
    const dialog = new FakeElement(document, [cancel]);
    trigger.disabled = true;

    const deactivate = activateModalDialog(
      dialog as unknown as HTMLElement,
      trigger as unknown as HTMLElement,
      vi.fn(),
      () => result as unknown as HTMLElement,
    );
    deactivate();

    expect(document.activeElement).toBe(result);
  });
});
