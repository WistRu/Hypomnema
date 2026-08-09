const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
}

export type ConfirmedActionStatus = "idle" | "pending" | "error" | "success";

export function shouldDismissAfterConfirmedAction(
  actionRequested: boolean,
  status: ConfirmedActionStatus,
): boolean {
  return actionRequested && status === "success";
}

function canRestoreFocus(target: HTMLElement | null): target is HTMLElement {
  return (
    target !== null &&
    target.isConnected !== false &&
    !("disabled" in target && target.disabled === true)
  );
}

export function activateModalDialog(
  dialog: HTMLElement,
  trigger: HTMLElement | null,
  dismiss: () => void,
  fallbackTarget?: () => HTMLElement | null,
): () => void {
  const initial = focusableElements(dialog)[0] ?? dialog;
  initial.focus({ preventScroll: true });

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      dismiss();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = focusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus({ preventScroll: true });
      return;
    }

    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    const active = dialog.ownerDocument.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  };

  dialog.addEventListener("keydown", onKeyDown);

  return () => {
    dialog.removeEventListener("keydown", onKeyDown);
    const target = canRestoreFocus(trigger)
      ? trigger
      : fallbackTarget?.() ?? null;
    if (canRestoreFocus(target)) target.focus({ preventScroll: true });
  };
}
