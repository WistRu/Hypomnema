import { z } from "zod";

import {
  ingestSnapshotBodyLimitBytes,
  snapshotTabFaviconUrlMaxLength,
  snapshotTabTitleMaxLength,
  tabUrlMaxLength,
} from "@tabhub/shared/limits";

export * from "@tabhub/shared/limits";

export const knownBrowserOptions = [
  "chrome",
  "yandex",
  "edge",
  "other",
] as const;

export const browserIdentifierSchema = z.string().trim().min(1).max(64);

export type BrowserIdentifier = z.infer<typeof browserIdentifierSchema>;

export const installationIdSchema = z.string().uuid();

export type InstallationId = z.infer<typeof installationIdSchema>;

export const browserSessionIdSchema = z.string().uuid();

export type BrowserSessionId = z.infer<typeof browserSessionIdSchema>;

export const browserConfigSchema = z.object({
  browser: browserIdentifierSchema,
});

export type BrowserConfig = z.infer<typeof browserConfigSchema>;

export const tabUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(tabUrlMaxLength)
  .refine((value) => URL.canParse(value), "Invalid URL");

export const snapshotTabSchema = z.object({
  tabId: z.number().int().nonnegative().optional(),
  url: tabUrlSchema,
  title: z.string().max(snapshotTabTitleMaxLength).optional(),
  windowId: z.number().int(),
  index: z.number().int().nonnegative(),
  faviconUrl: z.string().max(snapshotTabFaviconUrlMaxLength).optional(),
  active: z.boolean().optional(),
  audible: z.boolean().optional(),
  muted: z.boolean().optional(),
  discarded: z.boolean().optional(),
  pinned: z.boolean().optional(),
  lastAccessed: z.number().finite().nonnegative().optional(),
});

export type SnapshotTab = z.infer<typeof snapshotTabSchema>;

export const ingestSnapshotSchema = z
  .object({
    browser: browserIdentifierSchema,
    browserSessionId: browserSessionIdSchema.optional(),
    installationId: installationIdSchema.optional(),
    tabs: z.array(snapshotTabSchema),
  })
  .superRefine((snapshot, context) => {
    if (
      snapshot.browserSessionId !== undefined &&
      snapshot.installationId === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Browser session identity requires an installation identity",
        path: ["browserSessionId"],
      });
    }

    if (snapshot.installationId !== undefined) {
      const seenTabIds = new Set<number>();
      snapshot.tabs.forEach((tab, index) => {
        if (tab.tabId === undefined) {
          context.addIssue({
            code: "custom",
            message: "Modern snapshots require a native tab ID",
            path: ["tabs", index, "tabId"],
          });
        } else if (seenTabIds.has(tab.tabId)) {
          context.addIssue({
            code: "custom",
            message: "Native tab IDs must be unique within a snapshot",
            path: ["tabs", index, "tabId"],
          });
        } else {
          seenTabIds.add(tab.tabId);
        }
      });
    }

    const serialized = JSON.stringify(snapshot);
    const byteLength = new TextEncoder().encode(serialized).byteLength;

    if (byteLength > ingestSnapshotBodyLimitBytes) {
      context.addIssue({
        code: "custom",
        message: `Snapshot JSON cannot exceed ${ingestSnapshotBodyLimitBytes} bytes`,
      });
    }
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

export const ingestActivitySchema = z
  .strictObject({
    id: z.string().uuid(),
    browser: browserIdentifierSchema,
    installationId: installationIdSchema,
    browserSessionId: browserSessionIdSchema,
    browserTabId: z.number().int().nonnegative(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    url: tabUrlSchema,
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    foregroundMs: z.number().int().positive().max(120_000),
    engagedMs: z.number().int().nonnegative().max(120_000),
  })
  .superRefine((activity, context) => {
    const elapsedMs =
      Date.parse(activity.endedAt) - Date.parse(activity.startedAt);

    if (elapsedMs <= 0) {
      context.addIssue({
        code: "custom",
        message: "Activity must end after it starts",
        path: ["endedAt"],
      });
    }

    if (activity.foregroundMs > elapsedMs) {
      context.addIssue({
        code: "custom",
        message: "Foreground time cannot exceed the activity interval",
        path: ["foregroundMs"],
      });
    }

    if (activity.engagedMs > activity.foregroundMs) {
      context.addIssue({
        code: "custom",
        message: "Engaged time cannot exceed foreground time",
        path: ["engagedMs"],
      });
    }
  });

export type IngestActivity = z.infer<typeof ingestActivitySchema>;

export const ingestActivityResponseSchema = z.object({
  accepted: z.boolean(),
});

export type IngestActivityResponse = z.infer<
  typeof ingestActivityResponseSchema
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

export const tabInstanceSchema = z.object({
  instanceId: z.number().int().positive(),
  canonicalTabId: tabIdSchema,
  installationId: z.string().min(1),
  browserSessionId: browserSessionIdSchema.nullable().default(null),
  browserTabId: z.number().int().nonnegative().nullable(),
  url: z.string().trim().min(1),
  urlNormalized: z.string().trim().min(1),
  title: z.string().nullable(),
  browser: browserIdentifierSchema,
  windowId: z.number().int(),
  index: z.number().int().nonnegative(),
  faviconUrl: z.string().nullable(),
  active: z.boolean(),
  audible: z.boolean(),
  muted: z.boolean(),
  discarded: z.boolean(),
  pinned: z.boolean(),
  lastAccessed: z.number().finite().nonnegative().nullable(),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  foregroundTimeMs: z.number().int().nonnegative().default(0),
  engagedTimeMs: z.number().int().nonnegative().default(0),
  status: tabStatusSchema,
  importance: tabImportanceSchema,
  summary: z.string().nullable(),
  tagPaths: z.array(z.string()),
  duplicateGroupSize: z.number().int().positive(),
});

export type TabInstance = z.infer<typeof tabInstanceSchema>;

export const workspaceSelectionSchema = z.strictObject({
  instanceId: z.number().int().positive(),
  browser: browserIdentifierSchema,
  installationId: z.string().trim().min(1).max(256),
  browserSessionId: browserSessionIdSchema.nullable(),
  browserTabId: z.number().int().nonnegative().nullable(),
});

export type WorkspaceSelection = z.infer<typeof workspaceSelectionSchema>;

const workspaceNameSchema = z.string().trim().min(1).max(200);

export const createWorkspaceSchema = z.object({
  name: workspaceNameSchema,
  selections: z
    .array(workspaceSelectionSchema)
    .min(1)
    .refine(
      (selections) =>
        new Set(selections.map(({ instanceId }) => instanceId)).size ===
        selections.length,
      "Workspace selections must use unique instance IDs",
    ),
});

export type CreateWorkspace = z.infer<typeof createWorkspaceSchema>;

export const patchWorkspaceSchema = z.object({
  name: workspaceNameSchema,
});

export type PatchWorkspace = z.infer<typeof patchWorkspaceSchema>;

export const workspaceIdSchema = z.number().int().positive();

export const workspaceIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type WorkspaceIdParam = z.infer<typeof workspaceIdParamSchema>;

export const workspaceItemSchema = z.object({
  id: z.number().int().positive(),
  ordinal: z.number().int().nonnegative(),
  sourceInstanceId: z.number().int().positive(),
  canonicalTabId: tabIdSchema.nullable(),
  browser: browserIdentifierSchema,
  installationId: z.string().trim().min(1),
  browserSessionId: browserSessionIdSchema.nullable(),
  browserTabId: z.number().int().nonnegative().nullable(),
  url: tabUrlSchema,
  title: z.string().nullable(),
  windowId: z.number().int(),
  index: z.number().int().nonnegative(),
  faviconUrl: z.string().nullable(),
  active: z.boolean(),
  pinned: z.boolean(),
  audible: z.boolean(),
  muted: z.boolean(),
  discarded: z.boolean(),
  lastAccessed: z.number().finite().nonnegative().nullable(),
});

export type WorkspaceItem = z.infer<typeof workspaceItemSchema>;

export const workspaceSummarySchema = z.object({
  id: workspaceIdSchema,
  name: z.string(),
  itemCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

export const workspaceDetailSchema = workspaceSummarySchema.extend({
  items: z.array(workspaceItemSchema),
});

export type WorkspaceDetail = z.infer<typeof workspaceDetailSchema>;

export const workspaceListResponseSchema = z.object({
  items: z.array(workspaceSummarySchema),
});

export type WorkspaceListResponse = z.infer<
  typeof workspaceListResponseSchema
>;

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

export const graphQuerySchema = z.object({
  root_tag: tagPathSchema.optional(),
});

export type GraphQuery = z.infer<typeof graphQuerySchema>;

export const graphNodeSchema = z.object({
  id: tabIdSchema,
  title: z.string().nullable(),
  url: z.string(),
  browser: browserIdentifierSchema,
  status: tabStatusSchema,
  importance: tabImportanceSchema,
  isOpen: z.boolean(),
  tagPaths: z.array(z.string()),
  rootTags: z.array(z.string()),
});

export type GraphNode = z.infer<typeof graphNodeSchema>;

export const graphResponseSchema = z.object({
  nodes: z.array(graphNodeSchema),
  edges: z.array(tabLinkSchema),
});

export type GraphResponse = z.infer<typeof graphResponseSchema>;

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

export const knowledgeNodeTypeSchema = z.enum(["tab", "topic"]);

export type KnowledgeNodeType = z.infer<typeof knowledgeNodeTypeSchema>;

export const knowledgeNodeRefSchema = z.object({
  type: knowledgeNodeTypeSchema,
  id: z.number().int().positive(),
});

export type KnowledgeNodeRef = z.infer<typeof knowledgeNodeRefSchema>;

export const relationIdSchema = z.number().int().positive();

export const relationIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type RelationIdParam = z.infer<typeof relationIdParamSchema>;

export const knowledgeRelationSchema = z.object({
  id: relationIdSchema,
  from: knowledgeNodeRefSchema,
  to: knowledgeNodeRefSchema,
  kind: z.string(),
  note: z.string().nullable(),
  createdBy: assignedBySchema,
});

export type KnowledgeRelation = z.infer<typeof knowledgeRelationSchema>;

export const createKnowledgeRelationSchema = z.object({
  from: knowledgeNodeRefSchema,
  to: knowledgeNodeRefSchema,
  kind: linkKindInputSchema.default("related"),
  note: linkNoteInputSchema.optional(),
  createdBy: assignedBySchema,
});

export type CreateKnowledgeRelation = z.infer<
  typeof createKnowledgeRelationSchema
>;

export const patchKnowledgeRelationSchema = patchLinkSchema;

export type PatchKnowledgeRelation = z.infer<
  typeof patchKnowledgeRelationSchema
>;

export const relationListQuerySchema = z
  .object({
    node_type: knowledgeNodeTypeSchema.optional(),
    node_id: z.coerce.number().int().positive().optional(),
  })
  .refine(
    (query) =>
      (query.node_type === undefined) === (query.node_id === undefined),
    "node_type and node_id must be provided together",
  );

export type RelationListQuery = z.infer<typeof relationListQuerySchema>;

export const knowledgeRelationListResponseSchema = z.object({
  items: z.array(knowledgeRelationSchema),
});

export type KnowledgeRelationListResponse = z.infer<
  typeof knowledgeRelationListResponseSchema
>;

export const graphV2QuerySchema = z
  .object({
    root_topic_id: z.coerce.number().int().positive().optional(),
    focus_node_type: knowledgeNodeTypeSchema.optional(),
    focus_node_id: z.coerce.number().int().positive().optional(),
    focus_depth: z.coerce.number().int().min(1).max(5).optional(),
  })
  .refine(
    (query) => {
      const focusFields = [
        query.focus_node_type,
        query.focus_node_id,
        query.focus_depth,
      ];
      const providedCount = focusFields.filter(
        (value) => value !== undefined,
      ).length;
      return providedCount === 0 || providedCount === focusFields.length;
    },
    "focus_node_type, focus_node_id, and focus_depth must be provided together",
  );

export type GraphV2Query = z.infer<typeof graphV2QuerySchema>;

export const graphV2TabNodeSchema = graphNodeSchema.extend({
  type: z.literal("tab"),
});

export type GraphV2TabNode = z.infer<typeof graphV2TabNodeSchema>;

export const graphV2TopicNodeSchema = z.object({
  type: z.literal("topic"),
  id: tagIdSchema,
  name: persistedTagNameSchema,
  path: persistedTagPathSchema,
  parentId: tagIdSchema.nullable(),
  color: tagColorSchema,
  directTabCount: z.number().int().nonnegative(),
  tabCount: z.number().int().nonnegative(),
});

export type GraphV2TopicNode = z.infer<typeof graphV2TopicNodeSchema>;

export const graphV2NodeSchema = z.discriminatedUnion("type", [
  graphV2TabNodeSchema,
  graphV2TopicNodeSchema,
]);

export type GraphV2Node = z.infer<typeof graphV2NodeSchema>;

export const graphV2EdgeTypeSchema = z.enum([
  "containment",
  "membership",
  "relation",
]);

export type GraphV2EdgeType = z.infer<typeof graphV2EdgeTypeSchema>;

export const graphV2EdgeSchema = z.object({
  id: z.string().min(1),
  edgeType: graphV2EdgeTypeSchema,
  source: knowledgeNodeRefSchema,
  target: knowledgeNodeRefSchema,
  relationId: relationIdSchema.nullable(),
  relationKind: z.string().nullable(),
  note: z.string().nullable(),
  createdBy: assignedBySchema.nullable(),
});

export type GraphV2Edge = z.infer<typeof graphV2EdgeSchema>;

export const graphV2ResponseSchema = z.object({
  nodes: z.array(graphV2NodeSchema),
  edges: z.array(graphV2EdgeSchema),
});

export type GraphV2Response = z.infer<typeof graphV2ResponseSchema>;

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

const tabFilterQueryShape = {
  browser: browserIdentifierSchema.optional(),
  is_open: queryBooleanSchema.optional(),
  q: z.string().trim().min(1).max(500).optional(),
  status: tabStatusSchema.optional(),
  importance: z.coerce.number().pipe(tabImportanceSchema).optional(),
  tag: tagPathSchema.optional(),
};

export const tabBulkIdsQuerySchema = z.object(tabFilterQueryShape);

export type TabBulkIdsQuery = z.infer<typeof tabBulkIdsQuerySchema>;

export const tabBulkIdsResponseSchema = z.object({
  ids: z
    .array(tabIdSchema)
    .refine((ids) => new Set(ids).size === ids.length, "Tab IDs must be unique"),
});

export type TabBulkIdsResponse = z.infer<typeof tabBulkIdsResponseSchema>;

export const tabListQuerySchema = z
  .object({
    ...tabFilterQueryShape,
    search_mode: searchModeSchema.default("fulltext"),
    similar_to: z.coerce.number().int().positive().optional(),
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

export const tabInstanceListQuerySchema = z.object({
  browser: browserIdentifierSchema.optional(),
  q: z.string().trim().min(1).max(500).optional(),
  duplicates_only: queryBooleanSchema.default(false),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});

export type TabInstanceListQuery = z.infer<
  typeof tabInstanceListQuerySchema
>;

export const tabInstanceListResponseSchema = z.object({
  items: z.array(tabInstanceSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

export type TabInstanceListResponse = z.infer<
  typeof tabInstanceListResponseSchema
>;

export const tabInstanceBulkQuerySchema = tabInstanceListQuerySchema.pick({
  browser: true,
  q: true,
  duplicates_only: true,
});

export type TabInstanceBulkQuery = z.infer<
  typeof tabInstanceBulkQuerySchema
>;

export const tabInstanceBulkResponseSchema = z.object({
  items: z.array(tabInstanceSchema),
  total: z.number().int().nonnegative(),
});

export type TabInstanceBulkResponse = z.infer<
  typeof tabInstanceBulkResponseSchema
>;

export const duplicateGroupListQuerySchema = z.object({
  browser: browserIdentifierSchema.optional(),
  q: z.string().trim().min(1).max(500).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});

export type DuplicateGroupListQuery = z.infer<
  typeof duplicateGroupListQuerySchema
>;

export const duplicateGroupBulkQuerySchema = duplicateGroupListQuerySchema.pick({
  browser: true,
  q: true,
});

export type DuplicateGroupBulkQuery = z.infer<
  typeof duplicateGroupBulkQuerySchema
>;

export const duplicateGroupSchema = z.object({
  installationId: z.string().min(1),
  browser: browserIdentifierSchema,
  url: z.string().trim().min(1),
  count: z.number().int().min(2),
  keeperInstanceId: z.number().int().positive(),
  candidateInstanceIds: z.array(z.number().int().positive()),
  protectedInstanceIds: z.array(z.number().int().positive()),
  instances: z.array(tabInstanceSchema).min(2),
});

export type DuplicateGroup = z.infer<typeof duplicateGroupSchema>;

export const duplicateGroupListResponseSchema = z.object({
  items: z.array(duplicateGroupSchema),
  totalGroups: z.number().int().nonnegative(),
  totalTabsInGroups: z.number().int().nonnegative(),
  totalDuplicateCopies: z.number().int().nonnegative(),
  totalCloseCandidates: z.number().int().nonnegative(),
  totalProtected: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

export type DuplicateGroupListResponse = z.infer<
  typeof duplicateGroupListResponseSchema
>;

export const duplicateGroupBulkResponseSchema =
  duplicateGroupListResponseSchema.omit({
    page: true,
    pageSize: true,
  });

export type DuplicateGroupBulkResponse = z.infer<
  typeof duplicateGroupBulkResponseSchema
>;

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  database: z.literal("ok"),
  schemaVersion: z.number().int().nonnegative(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const tabCommandRelayLegacyProtocolVersion = 3 as const;
export const tabCommandRelayProtocolVersion = 4 as const;
export const tabCommandRelayCompatibleProtocolVersionSchema = z.union([
  z.literal(tabCommandRelayLegacyProtocolVersion),
  z.literal(tabCommandRelayProtocolVersion),
]);

export type TabCommandRelayCompatibleProtocolVersion = z.infer<
  typeof tabCommandRelayCompatibleProtocolVersionSchema
>;

const tabCommandRelayKnownBrowserSchema = z.enum(knownBrowserOptions);
const tabCommandRelayRequestIdSchema = z.string().uuid();
const tabCommandRelayOpaqueIdSchema = z.string().uuid();
const tabCommandRelayTimestampSchema = z.string().datetime();

export const tabCommandScopeSchema = z
  .object({
    browser: tabCommandRelayKnownBrowserSchema,
    browserSessionId: browserSessionIdSchema,
    installationId: installationIdSchema,
  })
  .strict();

export type TabCommandScope = z.infer<typeof tabCommandScopeSchema>;

export const tabCommandRelayPhysicalTargetSchema = z
  .object({
    expectedUrl: tabUrlSchema,
    tabId: z.number().int().nonnegative(),
  })
  .strict();

export type TabCommandRelayPhysicalTarget = z.infer<
  typeof tabCommandRelayPhysicalTargetSchema
>;

const tabCommandRelayPhysicalTargetsSchema = z
  .array(tabCommandRelayPhysicalTargetSchema)
  .min(1)
  .superRefine((targets, context) => {
    const targetIds = new Set<number>();
    targets.forEach((target, index) => {
      if (targetIds.has(target.tabId)) {
        context.addIssue({
          code: "custom",
          message: "Physical tab target IDs must be unique",
          path: [index, "tabId"],
        });
      }
      targetIds.add(target.tabId);
    });
  });

const tabCommandRelayMoveDestinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new-window") }).strict(),
  z
    .object({
      kind: z.literal("window"),
      windowId: z.number().int().nonnegative(),
    })
    .strict(),
]);

const tabCommandRelayWorkspaceDestinationSchema = z
  .object({ kind: z.literal("new-window") })
  .strict();

const tabCommandRelayWorkspaceTabSchema = z
  .object({
    muted: z.boolean(),
    pinned: z.boolean(),
    url: tabUrlSchema,
  })
  .strict();

export const tabCommandRelayClosePreviewTargetSchema =
  tabCommandRelayPhysicalTargetSchema
    .extend({
      keeper: tabCommandRelayPhysicalTargetSchema.optional(),
    })
    .strict();

export type TabCommandRelayClosePreviewTarget = z.infer<
  typeof tabCommandRelayClosePreviewTargetSchema
>;

export const tabCommandRelayClosePreviewTargetsSchema = z
  .array(tabCommandRelayClosePreviewTargetSchema)
  .min(1)
  .superRefine((targets, context) => {
    const targetIds = new Set<number>();
    targets.forEach((target, index) => {
      if (targetIds.has(target.tabId)) {
        context.addIssue({
          code: "custom",
          message: "Close-preview target IDs must be unique",
          path: [index, "tabId"],
        });
      }
      targetIds.add(target.tabId);
      if (
        target.keeper !== undefined &&
        target.keeper.expectedUrl !== target.expectedUrl
      ) {
        context.addIssue({
          code: "custom",
          message: "A keeper must still have the candidate's exact URL",
          path: [index, "keeper", "expectedUrl"],
        });
      }
    });
    targets.forEach((target, index) => {
      if (
        target.keeper !== undefined &&
        targetIds.has(target.keeper.tabId)
      ) {
        context.addIssue({
          code: "custom",
          message: "A keeper cannot also be a close-preview target",
          path: [index, "keeper", "tabId"],
        });
      }
    });
  });

export const tabCommandRelayClosePreviewIntentSchema =
  z.literal("explicit-single");

export type TabCommandRelayClosePreviewIntent = z.infer<
  typeof tabCommandRelayClosePreviewIntentSchema
>;

export const tabCommandRelayCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("get-browser-state") }).strict(),
  z
    .object({
      kind: z.literal("activate-tab"),
      tabId: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      intent: tabCommandRelayClosePreviewIntentSchema.optional(),
      kind: z.literal("close-preview"),
      targets: tabCommandRelayClosePreviewTargetsSchema,
    })
    .strict()
    .superRefine((command, context) => {
      if (
        command.intent === "explicit-single" &&
        command.targets.length !== 1
      ) {
        context.addIssue({
          code: "custom",
          message: "An explicit single close must target exactly one tab",
          path: ["targets"],
        });
      }
    }),
  z
    .object({
      confirmed: z.literal(true),
      kind: z.literal("close"),
      previewId: tabCommandRelayOpaqueIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("undo-close"),
      undoId: tabCommandRelayOpaqueIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("set-pinned"),
      targets: tabCommandRelayPhysicalTargetsSchema,
      value: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("set-muted"),
      targets: tabCommandRelayPhysicalTargetsSchema,
      value: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("discard"),
      targets: tabCommandRelayPhysicalTargetsSchema,
    })
    .strict(),
  z
    .object({
      bypassCache: z.boolean().optional(),
      kind: z.literal("reload"),
      targets: tabCommandRelayPhysicalTargetsSchema,
    })
    .strict(),
  z
    .object({
      destination: tabCommandRelayMoveDestinationSchema,
      kind: z.literal("move"),
      targets: tabCommandRelayPhysicalTargetsSchema,
    })
    .strict(),
  z
    .object({
      destination: tabCommandRelayWorkspaceDestinationSchema,
      kind: z.literal("open-workspace"),
      tabs: z.array(tabCommandRelayWorkspaceTabSchema).min(1),
    })
    .strict(),
]);

export type TabCommandRelayCommand = z.infer<
  typeof tabCommandRelayCommandSchema
>;

const tabCommandRelaySkippedSchema = z
  .object({
    reason: z.string().min(1),
    tabId: z.number().int().nonnegative(),
  })
  .strict();

const tabCommandRelayFailureSchema = z
  .object({
    error: z.string().min(1),
    tabId: z.number().int().nonnegative(),
  })
  .strict();

const tabCommandRelayUndoSummarySchema = z
  .object({
    count: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    undoId: tabCommandRelayOpaqueIdSchema,
  })
  .strict();

const tabCommandRelayWindowSummarySchema = z
  .object({
    focused: z.boolean(),
    tabCount: z.number().int().nonnegative(),
    windowId: z.number().int().nonnegative(),
  })
  .strict();

const tabCommandRelayMutationResultFields = {
  failed: z.array(tabCommandRelayFailureSchema),
  requested: z.number().int().nonnegative(),
  skipped: z.array(tabCommandRelaySkippedSchema),
  succeededTabIds: z.array(z.number().int().nonnegative()),
} as const;

const tabCommandRelayWindowBoundsSchema = z
  .object({
    height: z.number().int().positive(),
    left: z.number().int(),
    top: z.number().int(),
    width: z.number().int().positive(),
  })
  .strict();

export const tabCommandRelayResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("get-browser-state"),
      pendingUndos: z.array(tabCommandRelayUndoSummarySchema).max(5),
      windows: z.array(tabCommandRelayWindowSummarySchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("activate-tab"),
      tabId: z.number().int().nonnegative(),
      windowBounds: tabCommandRelayWindowBoundsSchema.optional(),
      windowId: z.number().int().nonnegative(),
      windowTitle: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      candidateTabIds: z.array(z.number().int().nonnegative()),
      expiresAt: z.number().int().nonnegative(),
      kind: z.literal("close-preview"),
      previewId: tabCommandRelayOpaqueIdSchema,
      requested: z.number().int().nonnegative(),
      skipped: z.array(tabCommandRelaySkippedSchema),
    })
    .strict(),
  z
    .object({
      ...tabCommandRelayMutationResultFields,
      kind: z.literal("close"),
      undo: tabCommandRelayUndoSummarySchema.nullable().optional(),
    })
    .strict(),
  z
    .object({
      failed: z.array(tabCommandRelayFailureSchema),
      kind: z.literal("undo-close"),
      requested: z.number().int().nonnegative(),
      restoredTabIds: z.array(z.number().int().nonnegative()),
      retry: tabCommandRelayUndoSummarySchema.optional(),
      skipped: z.array(tabCommandRelaySkippedSchema),
    })
    .strict(),
  z
    .object({
      ...tabCommandRelayMutationResultFields,
      kind: z.literal("set-pinned"),
    })
    .strict(),
  z
    .object({
      ...tabCommandRelayMutationResultFields,
      kind: z.literal("set-muted"),
    })
    .strict(),
  z
    .object({
      ...tabCommandRelayMutationResultFields,
      kind: z.literal("discard"),
    })
    .strict(),
  z
    .object({
      ...tabCommandRelayMutationResultFields,
      kind: z.literal("reload"),
    })
    .strict(),
  z
    .object({
      ...tabCommandRelayMutationResultFields,
      destinationWindowId: z.number().int().nonnegative().optional(),
      kind: z.literal("move"),
    })
    .strict(),
  z
    .object({
      destinationWindowId: z.number().int().nonnegative().optional(),
      failed: z.array(
        z
          .object({
            error: z.string().min(1),
            index: z.number().int().nonnegative(),
          })
          .strict(),
      ),
      kind: z.literal("open-workspace"),
      openedTabIds: z.array(z.number().int().nonnegative()),
      requested: z.number().int().nonnegative(),
    })
    .strict(),
]);

export type TabCommandRelayResult = z.infer<
  typeof tabCommandRelayResultSchema
>;

export const tabCommandRelayHttpRequestSchema = tabCommandScopeSchema
  .extend({ command: tabCommandRelayCommandSchema })
  .strict();

export type TabCommandRelayHttpRequest = z.infer<
  typeof tabCommandRelayHttpRequestSchema
>;

export const tabCommandRelayConnectedScopeSchema = tabCommandScopeSchema
  .extend({
    connectedAt: tabCommandRelayTimestampSchema,
    lastSeenAt: tabCommandRelayTimestampSchema,
    protocolVersion: tabCommandRelayCompatibleProtocolVersionSchema,
  })
  .strict();

export type TabCommandRelayConnectedScope = z.infer<
  typeof tabCommandRelayConnectedScopeSchema
>;

export const tabCommandRelayConnectedScopesResponseSchema = z
  .object({ items: z.array(tabCommandRelayConnectedScopeSchema) })
  .strict();

export type TabCommandRelayConnectedScopesResponse = z.infer<
  typeof tabCommandRelayConnectedScopesResponseSchema
>;

export const tabCommandRelayRegisterEnvelopeSchema = z
  .object({
    scope: tabCommandScopeSchema,
    type: z.literal("register"),
    version: z.literal(tabCommandRelayProtocolVersion),
  })
  .strict();

export const tabCommandRelayReadyEnvelopeSchema = z
  .object({
    connectedAt: tabCommandRelayTimestampSchema,
    heartbeatIntervalMs: z.number().int().positive(),
    scope: tabCommandScopeSchema,
    type: z.literal("ready"),
    version: z.literal(tabCommandRelayProtocolVersion),
  })
  .strict();

export const tabCommandRelayPingEnvelopeSchema = z
  .object({
    heartbeatId: tabCommandRelayRequestIdSchema,
    sentAt: tabCommandRelayTimestampSchema,
    type: z.literal("ping"),
    version: z.literal(tabCommandRelayProtocolVersion),
  })
  .strict();

export const tabCommandRelayPongEnvelopeSchema = z
  .object({
    heartbeatId: tabCommandRelayRequestIdSchema,
    type: z.literal("pong"),
    version: z.literal(tabCommandRelayProtocolVersion),
  })
  .strict();

export const tabCommandRelayCommandEnvelopeSchema = z
  .object({
    command: tabCommandRelayCommandSchema,
    executionDeadlineAt: z.number().int().nonnegative(),
    requestId: tabCommandRelayRequestIdSchema,
    scope: tabCommandScopeSchema,
    type: z.literal("command"),
    version: z.literal(tabCommandRelayProtocolVersion),
  })
  .strict();

const tabCommandRelaySuccessfulResultEnvelopeSchema = z
  .object({
    ok: z.literal(true),
    requestId: tabCommandRelayRequestIdSchema,
    result: tabCommandRelayResultSchema,
    scope: tabCommandScopeSchema,
    type: z.literal("result"),
    version: z.literal(tabCommandRelayProtocolVersion),
  })
  .strict();

const tabCommandRelayFailedResultEnvelopeSchema = z
  .object({
    error: z.string().min(1),
    ok: z.literal(false),
    requestId: tabCommandRelayRequestIdSchema,
    scope: tabCommandScopeSchema,
    type: z.literal("result"),
    version: z.literal(tabCommandRelayProtocolVersion),
  })
  .strict();

export const tabCommandRelayResultEnvelopeSchema = z.union([
  tabCommandRelaySuccessfulResultEnvelopeSchema,
  tabCommandRelayFailedResultEnvelopeSchema,
]);

export const tabCommandRelayClientEnvelopeSchema = z.union([
  tabCommandRelayRegisterEnvelopeSchema,
  tabCommandRelayPongEnvelopeSchema,
  tabCommandRelayResultEnvelopeSchema,
]);

export type TabCommandRelayClientEnvelope = z.infer<
  typeof tabCommandRelayClientEnvelopeSchema
>;

export const tabCommandRelayServerEnvelopeSchema = z.union([
  tabCommandRelayReadyEnvelopeSchema,
  tabCommandRelayPingEnvelopeSchema,
  tabCommandRelayCommandEnvelopeSchema,
]);

export type TabCommandRelayServerEnvelope = z.infer<
  typeof tabCommandRelayServerEnvelopeSchema
>;

export const tabCommandRelayErrorCodeSchema = z.enum([
  "SCOPE_OFFLINE",
  "EXTENSION_PROTOCOL_UNSUPPORTED",
  "COMMAND_TIMEOUT",
  "EXTENSION_DISCONNECTED",
  "EXTENSION_COMMAND_FAILED",
  "INVALID_COMMAND_RECEIPT",
  "FOREGROUND_HANDOFF_FAILED",
]);

export type TabCommandRelayErrorCode = z.infer<
  typeof tabCommandRelayErrorCodeSchema
>;

const tabCommandRelayHttpSuccessSchema = z
  .object({
    ok: z.literal(true),
    requestId: tabCommandRelayRequestIdSchema,
    result: tabCommandRelayResultSchema,
    scope: tabCommandScopeSchema,
  })
  .strict();

const tabCommandRelayHttpFailureSchema = z
  .object({
    error: tabCommandRelayErrorCodeSchema,
    message: z.string().min(1),
    ok: z.literal(false),
    outcome: z.enum(["not-sent", "unknown"]),
    requestId: tabCommandRelayRequestIdSchema.optional(),
  })
  .strict();

export const tabCommandRelayHttpResponseSchema = z.union([
  tabCommandRelayHttpSuccessSchema,
  tabCommandRelayHttpFailureSchema,
]);

export type TabCommandRelayHttpResponse = z.infer<
  typeof tabCommandRelayHttpResponseSchema
>;
