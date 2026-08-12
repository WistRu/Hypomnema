import type { RetentionForgetResponse } from "@tabhub/shared";

export const RETENTION_FORGET_CONFIRMATION =
  "Close every open copy of this page and move it to Trash? You can restore it for 7 days.";

const BLOCKED_LABELS: Record<
  NonNullable<RetentionForgetResponse["reason"]>,
  string
> = {
  scope_offline: "The owning browser session is offline. Nothing was forgotten.",
  outcome_unknown:
    "The browser result is unknown. Nothing was forgotten from the Library.",
  unaddressable_instance:
    "An open copy could not be addressed safely. Nothing was forgotten.",
  preview_changed:
    "The open copies changed during confirmation. Nothing was forgotten.",
  close_incomplete:
    "Not every open copy closed successfully. Nothing was forgotten.",
  instances_remain:
    "Open copies still remain. Nothing was forgotten from the Library.",
};

export function retentionBlockedMessageKey(
  reason: RetentionForgetResponse["reason"],
): string {
  return reason === null
    ? "TabHub could not safely forget this page."
    : BLOCKED_LABELS[reason];
}
