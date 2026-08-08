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

export const searchModeSchema = z.enum(["fulltext", "semantic"]);

export type SearchMode = z.infer<typeof searchModeSchema>;

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

const customFieldKeyInputSchema = z.string().trim().min(1).max(256);
const customFieldValueInputSchema = z.string().max(100_000).nullable();

const patchCustomFieldsSchema = z
  .record(customFieldKeyInputSchema, customFieldValueInputSchema)
  .refine(
    (fields) => Object.keys(fields).length > 0,
    "At least one custom field is required",
  )
  .refine(
    (fields) => Object.keys(fields).length <= 100,
    "At most 100 custom fields can be changed at once",
  );

export const patchTabSchema = z
  .object({
    status: tabStatusSchema.optional(),
    importance: tabImportanceSchema.optional(),
    customFields: patchCustomFieldsSchema.optional(),
  })
  .refine(
    (input) =>
      input.status !== undefined ||
      input.importance !== undefined ||
      input.customFields !== undefined,
    "At least one tab field is required",
  );

export type PatchTab = z.infer<typeof patchTabSchema>;

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

export const setImportanceSchema = z.object({
  ids: tabIdsSchema,
  importance: tabImportanceSchema,
});

export type SetImportance = z.infer<typeof setImportanceSchema>;

export const setImportanceResponseSchema = z.object({
  updated: z.number().int().nonnegative(),
  importance: tabImportanceSchema,
});

export type SetImportanceResponse = z.infer<
  typeof setImportanceResponseSchema
>;

export const tagIdSchema = z.number().int().positive();

export const tagIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type TagIdParam = z.infer<typeof tagIdParamSchema>;

const tagNameInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((name) => !name.includes("/"), "Tag names cannot contain slashes");
const tagColorInputSchema = z.string().max(128).nullable();

export const createTagSchema = z.object({
  name: tagNameInputSchema,
  parentId: tagIdSchema.optional(),
  color: tagColorInputSchema.optional(),
});

export type CreateTag = z.infer<typeof createTagSchema>;

export const patchTagSchema = z
  .object({
    name: tagNameInputSchema.optional(),
    parentId: tagIdSchema.nullable().optional(),
    color: tagColorInputSchema.optional(),
  })
  .refine(
    (input) =>
      input.name !== undefined ||
      input.parentId !== undefined ||
      input.color !== undefined,
    "At least one tag field is required",
  );

export type PatchTag = z.infer<typeof patchTagSchema>;

export const tagRecordSchema = z.object({
  id: tagIdSchema,
  name: z.string(),
  parentId: tagIdSchema.nullable(),
  color: z.string().nullable(),
});

export type TagRecord = z.infer<typeof tagRecordSchema>;

export const tabTagIdsParamSchema = z.object({
  tabId: z.coerce.number().int().positive(),
  tagId: z.coerce.number().int().positive(),
});

export type TabTagIdsParam = z.infer<typeof tabTagIdsParamSchema>;

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
  tagPaths: z.array(z.string()),
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

const linkKindInputSchema = z.string().trim().min(1).max(128);
const linkNoteInputSchema = z.string().max(10_000).nullable();

export const linkIdSchema = z.number().int().positive();

export const linkIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type LinkIdParam = z.infer<typeof linkIdParamSchema>;

export const linkListQuerySchema = z.object({
  tab_id: z.coerce.number().int().positive().optional(),
});

export type LinkListQuery = z.infer<typeof linkListQuerySchema>;

export const linkListResponseSchema = z.object({
  items: z.array(tabLinkSchema),
});

export type LinkListResponse = z.infer<typeof linkListResponseSchema>;

export const createLinkSchema = z.object({
  from: tabIdSchema,
  to: tabIdSchema,
  kind: linkKindInputSchema.default("related"),
  note: linkNoteInputSchema.optional(),
  createdBy: assignedBySchema,
});

export type CreateLink = z.infer<typeof createLinkSchema>;

export const patchLinkSchema = z
  .object({
    kind: linkKindInputSchema.optional(),
    note: linkNoteInputSchema.optional(),
  })
  .refine(
    (input) => input.kind !== undefined || input.note !== undefined,
    "At least one link field is required",
  );

export type PatchLink = z.infer<typeof patchLinkSchema>;

export const deleteResponseSchema = z.object({
  deleted: z.literal(true),
});

export type DeleteResponse = z.infer<typeof deleteResponseSchema>;

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

export const summaryDepthSchema = z.enum(["short", "deep"]);

export type SummaryDepth = z.infer<typeof summaryDepthSchema>;

export const summarizeTabSchema = z.object({
  depth: summaryDepthSchema,
  requestedBy: assignedBySchema.default("user"),
});

export type SummarizeTab = z.infer<typeof summarizeTabSchema>;

export const summaryJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
]);

export type SummaryJobStatus = z.infer<typeof summaryJobStatusSchema>;

export const summaryUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().finite().nonnegative(),
});

export type SummaryUsage = z.infer<typeof summaryUsageSchema>;

export const summaryJobResultSchema = z.object({
  summary: z.string(),
  model: z.string(),
  usage: summaryUsageSchema,
});

export type SummaryJobResult = z.infer<typeof summaryJobResultSchema>;

export const jobIdSchema = z.number().int().positive();

export const jobIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type JobIdParam = z.infer<typeof jobIdParamSchema>;

export const summaryEnqueueResponseSchema = z.object({
  jobId: jobIdSchema,
  status: summaryJobStatusSchema,
});

export type SummaryEnqueueResponse = z.infer<
  typeof summaryEnqueueResponseSchema
>;

export const summaryJobSchema = z.object({
  id: jobIdSchema,
  tabId: tabIdSchema,
  depth: summaryDepthSchema,
  status: summaryJobStatusSchema,
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  nextAttemptAt: z.string().datetime().nullable(),
  error: z.string().nullable(),
  result: summaryJobResultSchema.nullable(),
});

export type SummaryJob = z.infer<typeof summaryJobSchema>;

export const embeddingReindexRequestSchema = z.object({
  limit: z.number().int().positive().max(1_000).default(100),
});

export type EmbeddingReindexRequest = z.infer<
  typeof embeddingReindexRequestSchema
>;

export const embeddingReindexResponseSchema = z.object({
  indexed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  provider: z.string(),
  model: z.string(),
  dimensions: z.literal(512),
});

export type EmbeddingReindexResponse = z.infer<
  typeof embeddingReindexResponseSchema
>;

export const clusterInboxRequestSchema = z.object({
  maxClusters: z.number().int().min(1).max(50).default(8),
});

export type ClusterInboxRequest = z.infer<typeof clusterInboxRequestSchema>;

export const inboxClusterSchema = z.object({
  name: z.string(),
  keywords: z.array(z.string()),
  tabIds: z.array(tabIdSchema),
  size: z.number().int().nonnegative(),
});

export type InboxCluster = z.infer<typeof inboxClusterSchema>;

export const clusterInboxResponseSchema = z.object({
  clusters: z.array(inboxClusterSchema),
  indexed: z.number().int().nonnegative(),
  unclustered: z.number().int().nonnegative(),
});

export type ClusterInboxResponse = z.infer<
  typeof clusterInboxResponseSchema
>;

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

export const tabListQuerySchema = z
  .object({
    browser: browserIdentifierSchema.optional(),
    is_open: queryBooleanSchema.optional(),
    q: z.string().trim().min(1).max(500).optional(),
    search_mode: searchModeSchema.default("fulltext"),
    similar_to: z.coerce.number().int().positive().optional(),
    status: tabStatusSchema.optional(),
    importance: z.coerce.number().pipe(tabImportanceSchema).optional(),
    tag: tagPathSchema.optional(),
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().positive().max(200).default(50),
  })
  .superRefine((query, context) => {
    if (query.q !== undefined && query.similar_to !== undefined) {
      context.addIssue({
        code: "custom",
        message: "q and similar_to cannot be combined",
      });
    }

    if (
      query.search_mode === "semantic" &&
      query.q === undefined &&
      query.similar_to === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Semantic search requires q or similar_to",
      });
    }

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
