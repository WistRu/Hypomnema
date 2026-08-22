export type ContextLedgerErrorCode =
  | "LOGICAL_PAGE_NOT_FOUND"
  | "RESOURCE_NOT_FOUND"
  | "RESOURCE_NOT_ACTIVE"
  | "CONTEXT_ENTRY_NOT_FOUND"
  | "CONTEXT_SUBJECT_MISMATCH"
  | "CONTEXT_ENTRY_NOT_CURRENT"
  | "CONTEXT_STATE_INVALID"
  | "CONTEXT_REVIEW_NOT_ALLOWED"
  | "IDEMPOTENCY_KEY_CONFLICT";

const messages: Record<ContextLedgerErrorCode, string> = {
  LOGICAL_PAGE_NOT_FOUND: "Logical page not found",
  RESOURCE_NOT_FOUND: "Resource not found",
  RESOURCE_NOT_ACTIVE: "Resource is not active",
  CONTEXT_ENTRY_NOT_FOUND: "Context entry not found",
  CONTEXT_SUBJECT_MISMATCH: "Context entry belongs to a different subject",
  CONTEXT_ENTRY_NOT_CURRENT: "Context entry is not the current revision",
  CONTEXT_STATE_INVALID: "Context entry is not in the required state",
  CONTEXT_REVIEW_NOT_ALLOWED: "Only agent-authored context can be reviewed",
  IDEMPOTENCY_KEY_CONFLICT: "Idempotency key was already used for another command",
};

export class ContextLedgerError extends Error {
  constructor(readonly code: ContextLedgerErrorCode) {
    super(messages[code]);
    this.name = "ContextLedgerError";
  }
}
