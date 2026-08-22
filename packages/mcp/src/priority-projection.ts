import {
  priorityFeedbackReceiptSchema,
  prioritySafeReadSchema,
  type PriorityFeedbackReceipt,
  type PrioritySafeRead,
} from "@tabhub/shared";
import * as z from "zod/v4";

const boundedDetailTextSchema = z.string().trim().min(1).max(1_024);
const mcpPriorityExclusionDetailSchema = z.union([
  z.object({}).strict(),
  z.object({
    source: z.enum(["eligibility", "url_policy"]),
    code: z.string().trim().min(1).max(128).optional(),
  }).strict(),
  z.object({
    source: z.literal("rule"),
    ruleKey: boundedDetailTextSchema,
    label: boundedDetailTextSchema,
    competingRuleKeys: z.array(boundedDetailTextSchema).max(100),
  }).strict(),
]);

function samePrioritySubject(
  left: PrioritySafeRead["subject"],
  right: PrioritySafeRead["subject"],
): boolean {
  if (left.type === "page" && right.type === "page") {
    return left.logicalPageId === right.logicalPageId;
  }
  if (left.type === "resource" && right.type === "resource") {
    return left.resourceId === right.resourceId;
  }
  return false;
}

/**
 * The shared outcome contract deliberately leaves exclusion detail extensible.
 * MCP v1 exposes only the reviewed deterministic detail variants, so an
 * accidental private field from an upstream response fails closed.
 */
export function parseMcpPrioritySafeRead(value: unknown): PrioritySafeRead {
  const result = prioritySafeReadSchema.parse(value);
  if (result.outcome?.kind === "assessment") {
    if (!samePrioritySubject(result.subject, result.outcome.assessment.subject)) {
      throw new Error("Priority assessment has a mismatched subject");
    }
  } else if (result.outcome?.kind === "exclusion") {
    if (!samePrioritySubject(result.subject, result.outcome.exclusion.subject)) {
      throw new Error("Priority exclusion has a mismatched subject");
    }
    mcpPriorityExclusionDetailSchema.parse(result.outcome.exclusion.detail);
  }
  return result;
}

/** The agent route must never be accepted as user/manual provenance. */
export function parseMcpPriorityFeedbackReceipt(
  value: unknown,
): PriorityFeedbackReceipt {
  const result = priorityFeedbackReceiptSchema.parse(value);
  if (
    result.provenance.actor !== "agent" ||
    result.provenance.method !== "on_behalf_of_user"
  ) {
    throw new Error("Priority feedback receipt has invalid agent provenance");
  }
  return result;
}
