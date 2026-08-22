import { z } from "zod";

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const privacyPurgePublicTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("logical_page"), logicalPageId: positiveId }).strict(),
  z.object({ kind: z.literal("run"), researchRunId: positiveId }).strict(),
  z.object({ kind: z.literal("resource_history"), resourceId: positiveId }).strict(),
]);

export type PrivacyPurgePublicTarget = z.infer<typeof privacyPurgePublicTargetSchema>;

export const privacyPurgeStartBodySchema = z.object({
  version: z.literal(1),
  idempotencyKey: z.string().trim().min(1).max(200),
  target: privacyPurgePublicTargetSchema,
}).strict();

export type PrivacyPurgeStartBody = z.infer<typeof privacyPurgeStartBodySchema>;

export const privacyPurgeIdSchema = z.string().regex(/^purge_[0-9a-f]{64}$/);

export const privacyPurgePublicStateSchema = z.enum([
  "waiting", "failed_hold", "ready", "committed", "completed", "failed",
]);

export const privacyPurgeStatusResponseSchema = z.object({
  version: z.literal(1),
  purgeId: privacyPurgeIdSchema,
  target: privacyPurgePublicTargetSchema,
  state: privacyPurgePublicStateSchema,
  progress: z.object({
    completedSteps: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    totalSteps: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict().refine((value) => value.completedSteps <= value.totalSteps),
  holdReason: z.enum(["awaiting_provider_settlement", "manual_review"]).nullable(),
  canRetry: z.boolean(),
  timestamps: z.object({
    createdAt: z.string().datetime({ offset: false }),
    updatedAt: z.string().datetime({ offset: false }),
    completedAt: z.string().datetime({ offset: false }).nullable(),
  }).strict(),
  result: z.object({
    deletedRows: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict().nullable(),
}).strict();

export type PrivacyPurgeStatusResponse = z.infer<typeof privacyPurgeStatusResponseSchema>;
