import { z } from "zod";

export const knownBrowserOptions = [
  "chrome",
  "yandex",
  "edge",
  "other",
] as const;

export const browserIdentifierSchema = z.string().trim().min(1).max(64);

export type BrowserIdentifier = z.infer<typeof browserIdentifierSchema>;

export const browserConfigSchema = z.object({
  browser: browserIdentifierSchema,
});

export type BrowserConfig = z.infer<typeof browserConfigSchema>;

export const tabUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(16_384)
  .refine((value) => URL.canParse(value), "Invalid URL");

export const snapshotTabSchema = z.object({
  url: tabUrlSchema,
  title: z.string().max(2_048).optional(),
  windowId: z.number().int(),
  index: z.number().int().nonnegative(),
  faviconUrl: z.string().max(16_384).optional(),
});

export type SnapshotTab = z.infer<typeof snapshotTabSchema>;

export const ingestSnapshotSchema = z.object({
  browser: browserIdentifierSchema,
  tabs: z.array(snapshotTabSchema).max(10_000),
});

export type IngestSnapshot = z.infer<typeof ingestSnapshotSchema>;

export const ingestSnapshotResponseSchema = z.object({
  upserted: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
});

export type IngestSnapshotResponse = z.infer<
  typeof ingestSnapshotResponseSchema
>;

export const ingestContentSchema = z.object({
  browser: browserIdentifierSchema,
  url: tabUrlSchema,
  text: z.string().max(2_000_000),
  htmlExcerpt: z.string().max(250_000),
});

export type IngestContent = z.infer<typeof ingestContentSchema>;

export const ingestContentResponseSchema = z.object({
  tabId: z.number().int().positive(),
  extractedAt: z.string().datetime(),
});

export type IngestContentResponse = z.infer<
  typeof ingestContentResponseSchema
>;

export const tabStatusSchema = z.enum([
  "inbox",
  "in_progress",
  "done",
  "archived",
]);

export type TabStatus = z.infer<typeof tabStatusSchema>;

export const tabImportanceSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

export type TabImportance = z.infer<typeof tabImportanceSchema>;

export const tabListItemSchema = z.object({
  id: z.number().int().positive(),
  url: z.string().trim().min(1),
  urlNormalized: z.string().trim().min(1),
  title: z.string().nullable(),
  browser: browserIdentifierSchema,
  windowId: z.number().int().nullable(),
  index: z.number().int().nonnegative().nullable(),
  faviconUrl: z.string().nullable(),
  status: tabStatusSchema,
  importance: tabImportanceSchema,
  isOpen: z.boolean(),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
  summary: z.string().nullable(),
});

export type TabListItem = z.infer<typeof tabListItemSchema>;

const queryBooleanSchema = z.preprocess((value) => {
  if (value === "true" || value === "1" || value === 1) {
    return true;
  }

  if (value === "false" || value === "0" || value === 0) {
    return false;
  }

  return value;
}, z.boolean());

export const tabListQuerySchema = z.object({
  browser: browserIdentifierSchema.optional(),
  is_open: queryBooleanSchema.optional(),
  q: z.string().trim().min(1).max(500).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});

export type TabListQuery = z.infer<typeof tabListQuerySchema>;

export const tabListResponseSchema = z.object({
  items: z.array(tabListItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

export type TabListResponse = z.infer<typeof tabListResponseSchema>;

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  database: z.literal("ok"),
  schemaVersion: z.number().int().nonnegative(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
