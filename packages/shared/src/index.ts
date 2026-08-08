import { z } from "zod";

export const tabStatusSchema = z.enum([
  "inbox",
  "in_progress",
  "done",
  "archived",
]);

export type TabStatus = z.infer<typeof tabStatusSchema>;

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  database: z.literal("ok"),
  schemaVersion: z.number().int().nonnegative(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
