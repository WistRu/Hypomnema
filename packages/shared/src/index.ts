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

export const tabIdSchema = z.number().int().positive();

export const tabIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type TabIdParam = z.infer<typeof tabIdParamSchema>;

export const assignedBySchema = z.enum(["user", "agent"]);

export type AssignedBy = z.infer<typeof assignedBySchema>;

export const tagPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .transform((path) =>
    path
      .split("/")
      .map((segment) => segment.trim())
      .join("/"),
  )
  .superRefine((path, context) => {
    const segments = path.split("/");

    if (segments.length > 32) {
      context.addIssue({
        code: "custom",
        message: "Tag paths cannot be deeper than 32 segments",
      });
    }

    if (segments.some((segment) => segment.length === 0)) {
      context.addIssue({
        code: "custom",
        message: "Tag path segments cannot be empty",
      });
    }

    if (segments.some((segment) => segment.length > 128)) {
      context.addIssue({
        code: "custom",
        message: "Tag path segments cannot exceed 128 characters",
      });
    }
  });

export type TagPath = z.infer<typeof tagPathSchema>;

export const patchTabStatusSchema = z.object({
  status: tabStatusSchema,
});

export type PatchTabStatus = z.infer<typeof patchTabStatusSchema>;

export const patchTabStatusResponseSchema = z.object({
  id: tabIdSchema,
  status: tabStatusSchema,
});

export type PatchTabStatusResponse = z.infer<
  typeof patchTabStatusResponseSchema
>;

export const tabIdsSchema = z
  .array(tabIdSchema)
  .min(1)
  .max(1_000)
  .refine((ids) => new Set(ids).size === ids.length, "Tab IDs must be unique");

export type TabIds = z.infer<typeof tabIdsSchema>;

export const setStatusSchema = z.object({
  ids: tabIdsSchema,
  status: tabStatusSchema,
});

export type SetStatus = z.infer<typeof setStatusSchema>;

export const setStatusResponseSchema = z.object({
  updated: z.number().int().nonnegative(),
  status: tabStatusSchema,
});

export type SetStatusResponse = z.infer<typeof setStatusResponseSchema>;

export const assignTagsSchema = z.object({
  ids: tabIdsSchema,
  tagPath: tagPathSchema,
  assignedBy: assignedBySchema,
});

export type AssignTags = z.infer<typeof assignTagsSchema>;

export const assignTagsResponseSchema = z.object({
  tagId: tabIdSchema,
  assigned: z.number().int().nonnegative(),
});

export type AssignTagsResponse = z.infer<typeof assignTagsResponseSchema>;

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

const persistedTagNameSchema = z.string();
const persistedTagPathSchema = z.string();
const tagColorSchema = z.string().nullable();

export const tabTagSchema = z.object({
  id: tabIdSchema,
  name: persistedTagNameSchema,
  path: persistedTagPathSchema,
  color: tagColorSchema,
  assignedBy: assignedBySchema,
});

export type TabTag = z.infer<typeof tabTagSchema>;

export const tabLinkSchema = z.object({
  id: tabIdSchema,
  fromTab: tabIdSchema,
  toTab: tabIdSchema,
  kind: z.string(),
  note: z.string().nullable(),
  createdBy: assignedBySchema,
});

export type TabLink = z.infer<typeof tabLinkSchema>;

export const customFieldsSchema = z.record(z.string(), z.string().nullable());

export type CustomFields = z.infer<typeof customFieldsSchema>;

export const tabContentSchema = z.object({
  text: ingestContentSchema.shape.text.nullable(),
  htmlExcerpt: ingestContentSchema.shape.htmlExcerpt.nullable(),
  summary: z.string().nullable(),
  summaryModel: z.string().nullable(),
  extractedAt: z.string().datetime().nullable(),
});

export type TabContent = z.infer<typeof tabContentSchema>;

export const tabDetailResponseSchema = tabListItemSchema.extend({
  content: tabContentSchema.nullable(),
  tags: z.array(tabTagSchema),
  links: z.array(tabLinkSchema),
  customFields: customFieldsSchema,
});

export type TabDetailResponse = z.infer<typeof tabDetailResponseSchema>;

type TagTreeNodeShape = {
  id: number;
  name: string;
  path: string;
  color: string | null;
  tabCount: number;
  children: TagTreeNodeShape[];
};

export const tagTreeNodeSchema: z.ZodType<TagTreeNodeShape> = z.lazy(() =>
  z.object({
    id: tabIdSchema,
    name: persistedTagNameSchema,
    path: persistedTagPathSchema,
    color: tagColorSchema,
    tabCount: z.number().int().nonnegative(),
    children: z.array(tagTreeNodeSchema),
  }),
);

export type TagTreeNode = z.infer<typeof tagTreeNodeSchema>;

export const tagTreeResponseSchema = z.object({
  items: z.array(tagTreeNodeSchema),
});

export type TagTreeResponse = z.infer<typeof tagTreeResponseSchema>;

export const statusCountSchema = z.object({
  status: tabStatusSchema,
  count: z.number().int().nonnegative(),
});

export type StatusCount = z.infer<typeof statusCountSchema>;

const statusCountsSchema = z.array(statusCountSchema).max(4);

export const browserStatsSchema = z.object({
  browser: browserIdentifierSchema,
  total: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
  byStatus: statusCountsSchema,
});

export type BrowserStats = z.infer<typeof browserStatsSchema>;

export const tagStatsSchema = z.object({
  tagId: tabIdSchema,
  name: persistedTagNameSchema,
  path: persistedTagPathSchema,
  total: z.number().int().nonnegative(),
  byStatus: statusCountsSchema,
});

export type TagStats = z.infer<typeof tagStatsSchema>;

export const statsResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
  byStatus: statusCountsSchema,
  byBrowser: z.array(browserStatsSchema),
  byTag: z.array(tagStatsSchema),
});

export type StatsResponse = z.infer<typeof statsResponseSchema>;

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
  status: tabStatusSchema.optional(),
  importance: z.coerce.number().pipe(tabImportanceSchema).optional(),
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
